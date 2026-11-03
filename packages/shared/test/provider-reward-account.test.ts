import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OgmiosProvider } from '../src/provider.ts';

// getRewardAccount reads a reward account with no default: the balance a withdrawal must take in full (Module-1's consent). Ogmios's
// reward account summary decides when it has an entry; Vector's Ogmios has none for a credential that is registered but not delegated
// (Script(M1) is never delegated), so Koios account_info decides then: registered gives rewards_available, anything else is not
// registered. Nothing falls back to 0. The answers below have the shapes Vector mainnet's Ogmios and Koios gave on 2026-11-03.

const OGMIOS_URL = 'https://ogmios-internal.example.cluster.local:1337';
const SUBMIT_URL = 'https://submit-internal.example.cluster.local:1338/api/submit/tx';
const KOIOS_URL = 'https://koios-internal.example.cluster.local:1339';
const M1 = 'a1'.repeat(28);
const SCRIPT = { type: 'Script' as const, hash: M1 };
const REWARD_ADDRESS = 'stake17xs6rq0jlpw0c9mu2gqlsmzmfu0vy5qnfvzw3qlhf9wa7cgzsmxx7';

interface Seen { url: string; body: unknown }
type Answer = { status?: number; json?: unknown; network?: true };

/** A fetch that answers Ogmios and Koios account_info from the two answers given, and records what was asked. */
function stubbedFetch(ogmios: Answer, koios: Answer, seen: Seen[]): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    seen.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
    const answer = url.startsWith(OGMIOS_URL) ? ogmios : url === `${KOIOS_URL}/api/v1/account_info` ? koios : { status: 500, json: { unexpected: url } };
    if (answer.network) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.json ?? null), { status: answer.status ?? 200, statusText: answer.status === 503 ? 'Service Unavailable' : 'OK' });
  }) as typeof fetch;
}

async function read(ogmios: Answer, koios: Answer, opts: { koiosUrl?: string | null; credential?: { type: 'Key' | 'Script'; hash: string } } = {}) {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubbedFetch(ogmios, koios, seen);
  const provider = new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL, ...(opts.koiosUrl === null ? {} : { koiosUrl: opts.koiosUrl ?? KOIOS_URL }) });
  try {
    return { result: await provider.getRewardAccount(opts.credential ?? SCRIPT, REWARD_ADDRESS), seen };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), seen };
  } finally {
    globalThis.fetch = original;
  }
}

const summary = (lovelace: unknown, credential = M1) => ({ jsonrpc: '2.0', method: 'queryLedgerState/rewardAccountSummaries', result: [{ from: 'script', credential, stakePool: { id: 'pool1x' }, rewards: { ada: { lovelace } }, deposit: { ada: { lovelace: 0 } } }], id: null });
const noSummary = { jsonrpc: '2.0', method: 'queryLedgerState/rewardAccountSummaries', result: [], id: null };
const accountRow = (status: string, rewardsAvailable: unknown) => [{ stake_address: REWARD_ADDRESS, status, delegated_pool: null, rewards_available: rewardsAvailable }];

describe('OgmiosProvider.getRewardAccount', () => {
  test('a summary from Ogmios decides: its balance, and Koios is not asked', async () => {
    const { result, seen } = await read({ json: summary(1_234_567) }, { status: 500 });
    assert.deepEqual(result, { registered: true, rewards: 1_234_567n, source: 'ogmios' });
    assert.deepEqual(seen, [{ url: OGMIOS_URL, body: { jsonrpc: '2.0', method: 'queryLedgerState/rewardAccountSummaries', params: { scripts: [M1] }, id: null } }]);
  });

  test('no summary, and Koios says registered: the balance is rewards_available, never 0 by default', async () => {
    const { result, seen } = await read({ json: noSummary }, { json: accountRow('registered', '7654321') });
    assert.deepEqual(result, { registered: true, rewards: 7_654_321n, source: 'koios' });
    assert.deepEqual(seen.map((s) => s.url), [OGMIOS_URL, `${KOIOS_URL}/api/v1/account_info`]);
    assert.deepEqual(seen[1].body, { _stake_addresses: [REWARD_ADDRESS] });
  });

  test('no summary, and Koios says not registered or has no row: not registered', async () => {
    assert.deepEqual((await read({ json: noSummary }, { json: accountRow('not registered', '0') })).result, { registered: false, source: 'koios' });
    assert.deepEqual((await read({ json: noSummary }, { json: [] })).result, { registered: false, source: 'koios' });
    assert.deepEqual((await read({ json: summary(5, 'b2'.repeat(28)) }, { json: [] })).result, { registered: false, source: 'koios' }, 'a summary of another credential is no summary');
  });

  test('a key credential is asked for as a key', async () => {
    const { seen } = await read({ json: noSummary }, { json: [] }, { credential: { type: 'Key', hash: 'c3'.repeat(28) } });
    assert.deepEqual(seen[0].body, { jsonrpc: '2.0', method: 'queryLedgerState/rewardAccountSummaries', params: { keys: ['c3'.repeat(28)] }, id: null });
  });

  test('nothing falls back to 0: a read that fails or an answer that cannot be read throws, without the endpoint', async () => {
    const failures: Array<[Answer, Answer, RegExp, { koiosUrl?: string | null }?]> = [
      [{ status: 503 }, { json: [] }, /^Ogmios request failed \(queryLedgerState\/rewardAccountSummaries\): 503/],
      [{ json: { jsonrpc: '2.0', result: { not: 'a list' }, id: null } }, { json: [] }, /^Ogmios request failed \(queryLedgerState\/rewardAccountSummaries\): invalid response$/],
      [{ json: summary('12') }, { json: [] }, /^Ogmios request failed \(queryLedgerState\/rewardAccountSummaries\): invalid response$/],
      [{ json: noSummary }, { status: 503 }, /^Koios request failed \(account_info\): 503 Service Unavailable$/],
      [{ json: noSummary }, { network: true }, /^Koios request failed \(account_info\): network error$/],
      [{ json: noSummary }, { json: { not: 'a list' } }, /^Koios request failed \(account_info\): invalid response$/],
      [{ json: noSummary }, { json: accountRow('registered', 12) }, /^Koios request failed \(account_info\): invalid response$/],
      [{ json: noSummary }, { json: [] }, /^Koios URL is not configured/, { koiosUrl: null }],
    ];
    for (const [ogmios, koios, why, opts] of failures) {
      const { result, error } = await read(ogmios, koios, opts);
      assert.equal(result, undefined, String(why));
      assert.match(error ?? '', why);
      assert.ok(!(error ?? '').includes('example.cluster.local'), `no endpoint in "${error}"`);
    }
  });
});
