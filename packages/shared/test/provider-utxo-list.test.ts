import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { OgmiosProvider } from '../src/provider.ts';

// Some readers of OgmiosProvider ask Ogmios for a list: the outputs of an address (getUtxos, getUtxosWithUnit), the outputs of some output
// references (getUtxosByOutRef) and the budgets of the scripts of a transaction (evaluateTx, evaluateTransaction). An answer of the node
// that holds no list (`"result": null`, no `result`, or a `result` that is not an array) is an error that says so. It is never an empty
// list: a list that the node did not give is not "no outputs", and a caller that reads "no outputs" says "not found" where "cannot read"
// is right. An empty array is a list, and stays empty. The readers of other answers (the tip, the start time, the block height) do not
// ask for a list.

const OGMIOS_URL = 'https://ogmios-internal.example.cluster.local:1337';
const SUBMIT_URL = 'https://submit-internal.example.cluster.local:1338/api/submit/tx';
const ADDRESS = 'addr1vycjlux4jerlds2xa58qd9zy78jy96keugjr5tr9w0cd5us3dr78y';
const TX = 'ab'.repeat(32);
const POLICY = 'cd'.repeat(28);
const NAME = '74657374';
const UNIT = `${POLICY}${NAME}`;

/** The URLs in a text: a scheme, a host with an optional port, and an optional path. A test takes them out as a list and compares the list. */
const URL_IN_TEXT = /https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?/g;

type Answer = { status?: number; json?: unknown; network?: true };
interface Outcome<T> { value?: T; error?: string; seen: unknown[]; logged: string }

/** Runs `run` on a provider whose fetch gives `answer`. Records the request bodies and the lines that the provider writes to the log. */
async function ask<T>(answer: Answer, run: (provider: OgmiosProvider) => Promise<T>): Promise<Outcome<T>> {
  const seen: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    seen.push(JSON.parse(String(init?.body ?? 'null')));
    if (answer.network) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.json ?? null), { status: answer.status ?? 200, statusText: answer.status === 503 ? 'Service Unavailable' : 'OK' });
  }) as typeof fetch;
  const log = mock.method(console, 'error', () => undefined);
  let value: T | undefined;
  let error: string | undefined;
  try {
    value = await run(new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = original;
  }
  const logged = log.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  log.mock.restore();
  return { value, error, seen, logged };
}

const answerOf = (method: string, result: unknown): Answer => ({ json: { jsonrpc: '2.0', method, result, id: null } });
const UTXO_METHOD = 'queryLedgerState/utxo';
const EVALUATE_METHOD = 'evaluateTransaction';

/** The readers of a list: the name, the JSON-RPC method that it asks, and the call. */
const READERS: Array<[string, string, (provider: OgmiosProvider) => Promise<unknown>]> = [
  ['getUtxos', UTXO_METHOD, (provider) => provider.getUtxos(ADDRESS)],
  ['getUtxosWithUnit', UTXO_METHOD, (provider) => provider.getUtxosWithUnit(ADDRESS, UNIT)],
  ['getUtxosByOutRef', UTXO_METHOD, (provider) => provider.getUtxosByOutRef([{ txHash: TX, outputIndex: 0 }])],
  ['evaluateTx', EVALUATE_METHOD, (provider) => provider.evaluateTx('84a0')],
  ['evaluateTransaction', EVALUATE_METHOD, (provider) => provider.evaluateTransaction('84a0')],
];

/** The answers that hold no list. */
const NO_LIST: Array<[string, (method: string) => Answer]> = [
  ['a result of null', (method) => answerOf(method, null)],
  ['no result', () => ({ json: { jsonrpc: '2.0', id: null } })],
  ['an empty object', (method) => answerOf(method, {})],
  ['an object that holds a list', (method) => answerOf(method, { utxos: [], budgets: [] })],
  ['a text', (method) => answerOf(method, 'no outputs')],
  ['an empty text', (method) => answerOf(method, '')],
  ['the number 0', (method) => answerOf(method, 0)],
  ['true', (method) => answerOf(method, true)],
  ['false', (method) => answerOf(method, false)],
];

/** An output as Ogmios v6 gives it: lovelace, one token, and an inline datum. */
const OUTPUT = { transaction: { id: TX }, index: 3, address: ADDRESS, value: { ada: { lovelace: 5_000_000 }, [POLICY]: { [NAME]: 7 } }, datum: 'd87980' };
const LUCID_OUTPUT = { txHash: TX, outputIndex: 3, assets: { lovelace: 5_000_000n, [UNIT]: 7n }, address: ADDRESS, datumHash: null, datum: 'd87980', scriptRef: null };
const BUDGETS = [
  { validator: { index: 0, purpose: 'spend' }, budget: { memory: 1_200, cpu: 3_400_000 } },
  { validator: { index: 1, purpose: 'mint' }, budget: { memory: 5, cpu: 6 } },
];

describe('OgmiosProvider: the readers of a list', () => {
  test('a list that the node gives is read as before', async () => {
    const byAddress = await ask(answerOf(UTXO_METHOD, [OUTPUT]), (provider) => provider.getUtxos(ADDRESS));
    assert.deepEqual(byAddress.value, [LUCID_OUTPUT]);
    assert.deepEqual(byAddress.seen, [{ jsonrpc: '2.0', method: UTXO_METHOD, params: { addresses: [ADDRESS] }, id: null }]);

    const withUnit = await ask(answerOf(UTXO_METHOD, [OUTPUT, { ...OUTPUT, index: 4, value: { ada: { lovelace: 1_000_000 } } }]), (provider) => provider.getUtxosWithUnit(ADDRESS, UNIT));
    assert.deepEqual(withUnit.value, [LUCID_OUTPUT], 'the output without the token is filtered out');

    const byRef = await ask(answerOf(UTXO_METHOD, [OUTPUT]), (provider) => provider.getUtxosByOutRef([{ txHash: TX, outputIndex: 3 }]));
    assert.deepEqual(byRef.value, [LUCID_OUTPUT]);
    assert.deepEqual(byRef.seen, [{ jsonrpc: '2.0', method: UTXO_METHOD, params: { outputReferences: [{ transaction: { id: TX }, index: 3 }] }, id: null }]);

    const evaluated = await ask(answerOf(EVALUATE_METHOD, BUDGETS), (provider) => provider.evaluateTx('84a0'));
    assert.deepEqual(evaluated.value, [
      { ex_units: { mem: 1_200, steps: 3_400_000 }, redeemer_index: 0, redeemer_tag: 'spend' },
      { ex_units: { mem: 5, steps: 6 }, redeemer_index: 1, redeemer_tag: 'mint' },
    ]);
    assert.deepEqual(evaluated.seen, [{ jsonrpc: '2.0', method: EVALUATE_METHOD, params: { transaction: { cbor: '84a0' } }, id: null }]);

    const raw = await ask(answerOf(EVALUATE_METHOD, BUDGETS), (provider) => provider.evaluateTransaction('84a0'));
    assert.deepEqual(raw.value, BUDGETS, 'the raw alias gives the list as the node gave it');
  });

  test('an empty array is a list: every reader gives an empty list for it, and logs nothing', async () => {
    for (const [reader, method, run] of READERS) {
      const { value, error, logged } = await ask(answerOf(method, []), run);
      assert.equal(error, undefined, reader);
      assert.deepEqual(value, [], reader);
      assert.equal(logged, '', reader);
    }
  });

  test('an answer that holds no list is an error that says so, for every reader and every kind of answer', async () => {
    for (const [reader, method, run] of READERS) {
      for (const [what, answer] of NO_LIST) {
        const { value, error } = await ask(answer(method), run);
        assert.equal(value, undefined, `${reader}, ${what}: no empty list`);
        assert.equal(error, `Ogmios request failed (${method}): the node gave no list`, `${reader}, ${what}`);
      }
    }
  });

  test('the error has the form of the other failures of the file, and names neither the node nor the answer', async () => {
    const secret = 'token=hunter2';
    const { error, logged } = await ask(answerOf(UTXO_METHOD, secret), (provider) => provider.getUtxos(ADDRESS));
    assert.equal(error, 'Ogmios request failed (queryLedgerState/utxo): the node gave no list');
    assert.ok(!error!.includes('ogmios-internal') && !error!.includes(secret));
    assert.deepEqual(error!.match(URL_IN_TEXT) ?? [], [], 'the error holds no URL');
    assert.deepEqual(logged.match(URL_IN_TEXT) ?? [], [OGMIOS_URL], 'the operator log names the node, once');
    assert.ok(logged.includes('queryLedgerState/utxo') && logged.includes('the node gave no list'), 'the operator log names the method and the fault');
    assert.ok(!logged.includes(secret), 'the log does not copy the answer');
  });

  test('an error of the node, a failed status and a network failure keep their own errors', async () => {
    for (const [reader, method, run] of READERS) {
      const rpcError = await ask({ json: { jsonrpc: '2.0', error: { code: -32_602, message: 'bad request' }, id: null } }, run);
      assert.equal(rpcError.error, `Ogmios request failed (${method}): -32602 bad request`, reader);
      const status = await ask({ status: 503, json: { message: 'busy' } }, run);
      assert.equal(status.error, `Ogmios request failed (${method}): 503 Service Unavailable`, reader);
      const network = await ask({ network: true }, run);
      assert.equal(network.error, `Ogmios request failed (${method}): network error`, reader);
    }
  });
});

describe('OgmiosProvider: the readers of other answers do not ask for a list', () => {
  test('the tip, the start time, the block height and the parameters are read as before', async () => {
    const tip = await ask(answerOf('queryNetwork/tip', { slot: 99, id: 'ef'.repeat(32) }), (provider) => provider.getNetworkTip());
    assert.deepEqual(tip.value, { slot: 99, hash: 'ef'.repeat(32) });
    const start = await ask(answerOf('queryNetwork/startTime', '2025-08-29T16:40:00Z'), (provider) => provider.getSystemStartMs());
    assert.equal(start.value, Date.parse('2025-08-29T16:40:00Z'));
    const height = await ask(answerOf('queryNetwork/blockHeight', 12), (provider) => provider.getBlockHeight());
    assert.equal(height.value, 12);
    const parameters = await ask(answerOf('queryLedgerState/protocolParameters', { minFeeCoefficient: 44 }), (provider) => provider.getProtocolParameters());
    assert.equal(parameters.value?.minFeeA, 44);
  });
});
