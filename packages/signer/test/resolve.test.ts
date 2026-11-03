// packages/signer/test/resolve.test.ts
// The optional input resolver (src/resolve.ts) against a fake Ogmios: what it sends, how it reads the answer, and that every
// failure is a clear error that names neither the endpoint nor what the endpoint said. No network: `fetch` is a stand-in.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { ogmiosInputResolver, resolveInputs, type InputResolver } from '../src/resolve.ts';
import { RESOLUTION_OFF, type ResolvedOutput } from '../src/policy.ts';
import type { DecodedInput, DecodedTx } from '../src/decode.ts';

/** The configured URL carries a token: no error may repeat it. */
const OGMIOS = 'https://ogmios.example/rpc?token=hunter2';
const SECRETS = ['hunter2', 'ogmios.example'];
const KEY = 'a1'.repeat(28);
const keyAddress = (keyHash: string) =>
  CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(keyHash))).to_address().to_bech32();
const SCRIPT_ADDRESS = CML.EnterpriseAddress.new(1, CML.Credential.new_script(CML.ScriptHash.from_hex('c3'.repeat(28))))
  .to_address()
  .to_bech32();
const IN_A: DecodedInput = { txHash: '01'.repeat(32), index: 0 };
const IN_B: DecodedInput = { txHash: '02'.repeat(32), index: 3 };
const utxo = (input: DecodedInput, address: unknown, lovelace: unknown) => ({
  transaction: { id: input.txHash },
  index: input.index,
  address,
  value: { ada: { lovelace } },
});

interface Call { url: string; init: RequestInit; body: unknown }
/** A fake fetch that records each call and answers with `answer` (a JSON-RPC result list, or a Response of its own). */
function fakeOgmios(answer: unknown[] | Response | (() => Response) | Error): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (typeof answer === 'function') return answer();
    return new Response(JSON.stringify({ jsonrpc: '2.0', method: 'queryLedgerState/utxo', result: answer, id: null }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function rejection(resolver: InputResolver, inputs: DecodedInput[] = [IN_A]): Promise<string> {
  try {
    await resolver(inputs);
  } catch (err) {
    assert.ok(err instanceof Error);
    for (const secret of SECRETS) assert.ok(!err.message.includes(secret), `"${secret}" leaked into: ${err.message}`);
    return err.message;
  }
  assert.fail('expected the resolver to throw');
}

describe('ogmiosInputResolver', () => {
  test('asks once, by output reference, with the read-only ledger-state query and nothing else', async () => {
    const { f, calls } = fakeOgmios([utxo(IN_A, keyAddress(KEY), 5_000_000), utxo(IN_B, SCRIPT_ADDRESS, 2_000_000)]);
    await ogmiosInputResolver(OGMIOS, f)([IN_A, IN_B]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OGMIOS);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepStrictEqual(calls[0].body, {
      jsonrpc: '2.0',
      method: 'queryLedgerState/utxo',
      params: { outputReferences: [{ transaction: { id: IN_A.txHash }, index: 0 }, { transaction: { id: IN_B.txHash }, index: 3 }] },
      id: null,
    });
  });

  test('gives each output its address, its lovelace and the key hash of its payment credential (null for a script)', async () => {
    const { f } = fakeOgmios([utxo(IN_A, keyAddress(KEY), 5_000_000), utxo(IN_B, SCRIPT_ADDRESS, 2_000_000)]);
    const outputs = await ogmiosInputResolver(OGMIOS, f)([IN_A, IN_B]);
    assert.deepStrictEqual(outputs, new Map<string, ResolvedOutput>([
      [`${IN_A.txHash}#0`, { address: keyAddress(KEY), lovelace: 5_000_000n, paymentKeyHash: KEY }],
      [`${IN_B.txHash}#3`, { address: SCRIPT_ADDRESS, lovelace: 2_000_000n, paymentKeyHash: null }],
    ]));
  });

  test('an output that Ogmios does not return (spent, or not on chain yet) is simply absent', async () => {
    const { f } = fakeOgmios([utxo(IN_A, keyAddress(KEY), 5_000_000)]);
    const outputs = await ogmiosInputResolver(OGMIOS, f)([IN_A, IN_B]);
    assert.deepStrictEqual([...outputs.keys()], [`${IN_A.txHash}#0`]);
  });

  test('reads a transaction id in upper case as the same reference', async () => {
    const { f } = fakeOgmios([{ ...utxo(IN_A, keyAddress(KEY), 1), transaction: { id: IN_A.txHash.toUpperCase() } }]);
    assert.ok((await ogmiosInputResolver(OGMIOS, f)([IN_A])).has(`${IN_A.txHash}#0`));
  });

  describe('throws a clear error, without the endpoint or what it said, when', () => {
    const cases: Array<[string, Parameters<typeof fakeOgmios>[0], RegExp]> = [
      ['the endpoint cannot be reached', new TypeError(`fetch failed: connect ECONNREFUSED ${OGMIOS}`), /^Ogmios could not be reached \(network error or timeout\)$/],
      ['the endpoint answers an HTTP error', new Response('upstream ogmios.example down, token=hunter2', { status: 503 }), /^Ogmios answered HTTP 503$/],
      ['the answer is a JSON-RPC error', new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: 2000, message: 'hunter2' }, id: null })), /^Ogmios answered with JSON-RPC error 2000$/],
      ['the answer is not JSON', new Response('<html>ogmios.example hunter2</html>'), /^the Ogmios answer is not JSON$/],
      ['the answer is JSON but not a JSON-RPC object', new Response('null'), /^the Ogmios answer is not a JSON-RPC response$/],
      ['the answer holds no list', new Response(JSON.stringify({ result: { not: 'a list' } })), /^the Ogmios answer holds no list of outputs$/],
      ['the answer says it is too large', new Response('[]', { headers: { 'content-length': String(5 * 1024 * 1024) } }), /^the Ogmios answer is over 4194304 bytes$/],
      ['an output was not asked for', [utxo(IN_A, keyAddress(KEY), 1), utxo(IN_B, keyAddress(KEY), 1)], new RegExp(`^the Ogmios answer holds output ${IN_B.txHash}#3, which was not asked for$`)],
      ['an output comes twice', [utxo(IN_A, keyAddress(KEY), 1), utxo(IN_A, keyAddress(KEY), 1)], /holds output .*#0 twice$/],
      ['an output has no valid reference', [{ ...utxo(IN_A, keyAddress(KEY), 1), index: -1 }], /without a valid output reference$/],
      ['a transaction id is not 32 bytes of hex', [{ ...utxo(IN_A, keyAddress(KEY), 1), transaction: { id: 'abc' } }], /without a valid output reference$/],
      ['an amount is past the safe integers', [utxo(IN_A, keyAddress(KEY), 2 ** 53)], /lovelace amount that is not a safe whole number$/],
      ['an amount is negative', [utxo(IN_A, keyAddress(KEY), -1)], /lovelace amount that is not a safe whole number$/],
      ['an amount is a string', [utxo(IN_A, keyAddress(KEY), '1000')], /lovelace amount that is not a safe whole number$/],
      ['an address is not bech32 (for example a Byron address)', [utxo(IN_A, 'DdzFFzCqrhsxyz', 1)], /an address that is not bech32$/],
      ['an address is missing', [utxo(IN_A, undefined, 1)], /an address that is not bech32$/],
    ];
    for (const [name, answer, expected] of cases) {
      test(name, async () => {
        const { f } = fakeOgmios(answer);
        assert.match(await rejection(ogmiosInputResolver(OGMIOS, f)), expected);
      });
    }

    test('a streamed answer passes the size limit, with no length given', async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(0x20);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 5) controller.enqueue(chunk);
          else controller.close();
        },
      });
      const { f } = fakeOgmios(new Response(stream));
      assert.match(await rejection(ogmiosInputResolver(OGMIOS, f)), /^the Ogmios answer is over 4194304 bytes$/);
    });

    test('the answer stops part way (a timeout or a broken connection)', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"result":['));
        },
        pull(controller) {
          controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        },
      });
      const { f } = fakeOgmios(new Response(stream));
      assert.match(await rejection(ogmiosInputResolver(OGMIOS, f)), /^the Ogmios answer could not be read in full \(network error or timeout\)$/);
    });
  });
});

function txWith(inputs: DecodedInput[], collateralInputs: DecodedInput[] = []): DecodedTx {
  return {
    txHashHex: 'ff'.repeat(32), fee: 200_000n, outputs: [], inputCount: inputs.length, mintedAssetCount: 0,
    inputs, collateralInputs, collateralReturn: null, withdrawals: [], depositRefundKeyHashes: [], witnessKeyHashes: [], isValid: true,
  };
}

describe('resolveInputs', () => {
  test('without a resolver it is RESOLUTION_OFF, and nothing is asked', async () => {
    assert.equal(await resolveInputs(txWith([IN_A]), KEY, null), RESOLUTION_OFF);
  });

  test('asks once for every spent and collateral input, each reference once', async () => {
    const asked: DecodedInput[][] = [];
    const resolver: InputResolver = async (inputs) => { asked.push([...inputs]); return new Map(); };
    await resolveInputs(txWith([IN_A, IN_B], [IN_A]), KEY, resolver);
    assert.deepStrictEqual(asked, [[IN_A, IN_B]]);
  });

  test('gives the resolved outputs with the signer key hash in lower case', async () => {
    const outputs = new Map<string, ResolvedOutput>([[`${IN_A.txHash}#0`, { address: keyAddress(KEY), lovelace: 1n, paymentKeyHash: KEY }]]);
    const r = await resolveInputs(txWith([IN_A]), KEY.toUpperCase(), async () => outputs);
    assert.deepStrictEqual(r, { resolved: true, signerKeyHash: KEY, outputs });
  });

  test('turns a failure into an unresolved result that says why, and never throws', async () => {
    const r = await resolveInputs(txWith([IN_A]), KEY, async () => { throw new Error('Ogmios answered HTTP 502'); });
    assert.deepStrictEqual(r, { resolved: false, why: 'input resolution failed (Ogmios answered HTTP 502)' });
  });

  test('a transaction with no input asks nothing', async () => {
    let called = false;
    const r = await resolveInputs(txWith([]), KEY, async () => { called = true; return new Map(); });
    assert.equal(called, false);
    assert.equal(r.resolved, true);
  });
});
