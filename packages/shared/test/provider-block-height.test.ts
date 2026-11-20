import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { OgmiosProvider } from '../src/provider.ts';

// getBlockHeight reads the block height of the tip of the node (Ogmios queryNetwork/blockHeight). It gives a whole number that is not
// negative, and nothing else. A caller that compares block heights (the check for a gateway that lags) must never get a height that it
// cannot trust. Ogmios gives the text "origin" for a chain with no block: that is an error here, not a height.

const OGMIOS_URL = 'https://ogmios-internal.example.cluster.local:1337';
const SUBMIT_URL = 'https://submit-internal.example.cluster.local:1338/api/submit/tx';

type Answer = { status?: number; json?: unknown; network?: true };

/** Reads the height through a fetch that gives `answer`, and records the request bodies. The logs of the provider are muted. */
async function read(answer: Answer): Promise<{ height?: number; error?: string; seen: unknown[] }> {
  const seen: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    seen.push(JSON.parse(String(init?.body ?? 'null')));
    if (answer.network) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.json ?? null), { status: answer.status ?? 200, statusText: answer.status === 503 ? 'Service Unavailable' : 'OK' });
  }) as typeof fetch;
  const log = mock.method(console, 'error', () => undefined);
  try {
    const provider = new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL });
    return { height: await provider.getBlockHeight(), seen };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), seen };
  } finally {
    log.mock.restore();
    globalThis.fetch = original;
  }
}

const result = (value: unknown): Answer => ({ json: { jsonrpc: '2.0', method: 'queryNetwork/blockHeight', result: value, id: null } });
const REFUSED = 'Ogmios request failed (queryNetwork/blockHeight): invalid response';

describe('OgmiosProvider.getBlockHeight', () => {
  test('asks queryNetwork/blockHeight and gives the whole number that Ogmios answers', async () => {
    const { height, seen } = await read(result(9_548_792));
    assert.equal(height, 9_548_792);
    assert.deepEqual(seen, [{ jsonrpc: '2.0', method: 'queryNetwork/blockHeight', params: {}, id: null }]);
  });

  test('takes a height of 0 and the largest safe whole number', async () => {
    assert.equal((await read(result(0))).height, 0);
    assert.equal((await read(result(Number.MAX_SAFE_INTEGER))).height, Number.MAX_SAFE_INTEGER);
  });

  test('refuses every answer that is not a whole number that is not negative: origin, null, text, fraction, negative, too large, other types', async () => {
    for (const value of ['origin', null, '9548792', 1.5, -1, 2 ** 53, 1e308, true, false, {}, [], [9_548_792], { height: 9_548_792 }]) {
      const { height, error } = await read(result(value));
      assert.equal(height, undefined, JSON.stringify(value));
      assert.equal(error, REFUSED, JSON.stringify(value));
    }
  });

  test('refuses an answer without a result', async () => {
    assert.equal((await read({ json: { jsonrpc: '2.0', id: null } })).error, REFUSED);
  });

  test('an error of Ogmios, a failed HTTP status and a network failure are errors that do not name the node', async () => {
    const rpcError = await read({ json: { jsonrpc: '2.0', error: { code: -32_602, message: 'bad request' }, id: null } });
    assert.equal(rpcError.error, 'Ogmios request failed (queryNetwork/blockHeight): -32602 bad request');
    const status = await read({ status: 503, json: { message: 'busy' } });
    assert.equal(status.error, 'Ogmios request failed (queryNetwork/blockHeight): 503 Service Unavailable');
    const network = await read({ network: true });
    assert.equal(network.error, 'Ogmios request failed (queryNetwork/blockHeight): network error');
    for (const failure of [rpcError, status, network]) assert.ok(!(failure.error ?? '').includes('ogmios-internal'));
  });
});
