import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OGMIOS_ERROR_DATA_DEPTH_LIMIT, OGMIOS_ERROR_DATA_INPUT_LIMIT, OGMIOS_ERROR_DATA_LIMIT, OgmiosProvider, OgmiosRpcError, formatServiceError, scrubUrls } from '../src/provider.ts';

// OgmiosProvider throws an OgmiosRpcError, in place of the plain Error of the same message, when Ogmios answers with a JSON-RPC error
// object ({ error: { code, message, data? } }), in an answer whose HTTP status is not OK or in one that is OK. The message stays the
// sanitised summary, byte for byte; the new fields hold what the node said and nothing of the request or of the endpoint.

const OGMIOS = 'http://ogmios.test:1337';
const provider = () => new OgmiosProvider({ ogmiosUrl: OGMIOS, submitUrl: 'http://submit.test:8090/api/submit/tx', koiosUrl: 'http://koios.test' });

/** The body that Ogmios gives for an evaluation whose script fails: the code 3010 and one error for each validator that failed. */
const SCRIPT_FAILED = {
  jsonrpc: '2.0', method: 'evaluateTransaction',
  error: {
    code: 3010, message: 'Some scripts of the transactions terminated with error(s).',
    data: [{
      validator: { index: 0, purpose: 'spend' },
      error: { code: 3012, message: 'Some of the scripts failed to evaluate to a positive outcome.', data: { validationError: 'An error has occurred: (error)', traces: [] } },
    }],
  },
};

/** What `evaluateTx` throws when the node answers with `answer` (a Response) or does not answer (an Error); the lines of console.error come along. */
async function raised(answer: Response | Error): Promise<{ error: unknown; logged: unknown[][] }> {
  const realFetch = globalThis.fetch;
  const realLog = console.error;
  const logged: unknown[][] = [];
  globalThis.fetch = (async () => { if (answer instanceof Error) throw answer; return answer; }) as typeof fetch;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await provider().evaluateTx('00');
  } catch (error) {
    return { error, logged };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realLog;
  }
  return assert.fail('evaluateTx did not throw');
}
const json = (body: unknown, status: number, statusText: string) => new Response(JSON.stringify(body), { status, statusText });

const SCRIPTS_MESSAGE = 'Some scripts of the transactions terminated with error(s).';
/** The message of old for an evaluation answered with the code 3010: HTTP 400 gives the status, an answer that is OK gives the code. */
const messageOf = (status: number) => (status === 400
  ? formatServiceError('Ogmios', 'evaluateTransaction', 400, 'Bad Request')
  : formatServiceError('Ogmios', 'evaluateTransaction', 3010, SCRIPTS_MESSAGE));
/** An answer with the code 3010 whose `data` is the JSON text `dataText`: for a `data` that JSON.stringify cannot make in a test (too deep). */
const withData = (dataText: string, status = 400) =>
  new Response(`{"error":{"code":3010,"message":"${SCRIPTS_MESSAGE}","data":${dataText}}}`, { status, statusText: status === 400 ? 'Bad Request' : 'OK' });
/** An answer that is OK whose JSON is `body` itself, for a body that JSON text cannot carry: a cycle, a getter, a Proxy. */
const objectAnswer = (body: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
const nestedArrays = (levels: number) => '['.repeat(levels) + ']'.repeat(levels);
const nestedObjects = (levels: number) => '{"a":'.repeat(levels) + '1' + '}'.repeat(levels);
/** What the error must be when the provider dropped the data: the typed error of the node, with the message of old, and no data. */
function assertDropped(error: unknown, message: string, why: string): void {
  assert.ok(error instanceof OgmiosRpcError, `${why}: the typed error, not ${String(error)}`);
  assert.equal(error.message, message, `${why}: the message of old`);
  assert.deepEqual([error.method, error.code, error.rpcMessage], ['evaluateTransaction', 3010, SCRIPTS_MESSAGE], why);
  assert.deepEqual([error.data, error.dataDropped, error.dataTruncated], [null, true, false], why);
}

describe('OgmiosRpcError', () => {
  test('an HTTP answer that is not OK, with a JSON-RPC error: the typed error, with the message of old', async () => {
    const { error } = await raised(json(SCRIPT_FAILED, 400, 'Bad Request'));
    assert.ok(error instanceof OgmiosRpcError && error instanceof Error);
    assert.equal(error.message, formatServiceError('Ogmios', 'evaluateTransaction', 400, 'Bad Request'), 'byte for byte the message of the plain Error');
    assert.equal(error.name, 'OgmiosRpcError');
    assert.deepEqual([error.method, error.code, error.rpcMessage], ['evaluateTransaction', 3010, 'Some scripts of the transactions terminated with error(s).']);
    assert.equal(error.data, JSON.stringify(SCRIPT_FAILED.error.data));
    assert.equal(error.dataTruncated, false);
  });

  test('an answer that is OK with an error in its body: the typed error, with the message of old', async () => {
    const { error } = await raised(json({ jsonrpc: '2.0', error: { code: 3003, message: 'The node is too far behind.' } }, 200, 'OK'));
    assert.ok(error instanceof OgmiosRpcError);
    assert.equal(error.message, formatServiceError('Ogmios', 'evaluateTransaction', 3003, 'The node is too far behind.'));
    assert.deepEqual([error.code, error.rpcMessage, error.data, error.dataTruncated], [3003, 'The node is too far behind.', undefined, false]);
  });

  test('an answer that is no JSON-RPC error stays a plain Error with the message of old: HTML, JSON of another shape, a code that is no number', async () => {
    const plain = async (answer: Response, message: string) => {
      const { error } = await raised(answer);
      assert.ok(error instanceof Error && !(error instanceof OgmiosRpcError), message);
      assert.equal(error.message, message);
    };
    await plain(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }), formatServiceError('Ogmios', 'evaluateTransaction', 502, 'Bad Gateway'));
    await plain(json({ detail: 'no' }, 400, 'Bad Request'), formatServiceError('Ogmios', 'evaluateTransaction', 400, 'Bad Request'));
    await plain(json({ error: { code: '3010', message: 'text code' } }, 400, 'Bad Request'), formatServiceError('Ogmios', 'evaluateTransaction', 400, 'Bad Request'));
    await plain(json({ error: { code: 3010 } }, 200, 'OK'), formatServiceError('Ogmios', 'evaluateTransaction', 3010, 'RPC error'));
  });

  test('no answer, and an answer that is not JSON, stay plain Errors with the message of old', async () => {
    const down = await raised(new Error('fetch failed'));
    assert.ok(!(down.error instanceof OgmiosRpcError));
    assert.equal((down.error as Error).message, formatServiceError('Ogmios', 'evaluateTransaction', 'network error'));
    const html = await raised(new Response('not json', { status: 200 }));
    assert.ok(!(html.error instanceof OgmiosRpcError));
    assert.equal((html.error as Error).message, formatServiceError('Ogmios', 'evaluateTransaction', 'invalid response'));
  });

  test('the lines of console.error stay: the status and the whole body of the node, with the endpoint', async () => {
    const { logged } = await raised(json(SCRIPT_FAILED, 400, 'Bad Request'));
    assert.equal(logged.length, 1);
    const line = String(logged[0][0]);
    assert.ok(line.includes('Ogmios RPC error (evaluateTransaction)') && line.includes('400 Bad Request') && line.includes('"code":3012'), line);
    assert.deepEqual((line.match(/https?:\/\/\S+/g) ?? []).map((text) => text.replace(/[:,.]+$/, '')), [OGMIOS], line);
    const { logged: okLogged } = await raised(json({ error: { code: 3003, message: 'too far behind' } }, 200, 'OK'));
    assert.deepEqual(okLogged[0], [`[OgmiosProvider] Ogmios RPC error (evaluateTransaction) at ${OGMIOS}:`, { code: 3003, message: 'too far behind' }]);
  });

  test('nothing of the endpoint or of the request is in the error: its fields and its message hold neither, and a host that the node echoes is removed', async () => {
    const echo = { error: { code: 3010, message: `see ${OGMIOS}/docs and koios.test`, data: [{ note: `from http://submit.test:8090/api/submit/tx via ogmios.test` }] } };
    const { error } = await raised(json(echo, 400, 'Bad Request'));
    assert.ok(error instanceof OgmiosRpcError);
    const everything = JSON.stringify({ message: error.message, method: error.method, code: error.code, rpcMessage: error.rpcMessage, data: error.data });
    for (const secret of ['ogmios.test', 'koios.test', 'submit.test', '1337', 'http://']) assert.ok(!everything.includes(secret), `${secret} in ${everything}`);
    assert.match(error.rpcMessage, /^see \[endpoint\] and \[endpoint\]$/);
    assert.ok(!('params' in error) && !('request' in error) && !('url' in error));
  });

  test('a URL inside a string of the data does not break the JSON: each string is scrubbed alone, and the text is made after that', async () => {
    const traces = ['see https://example.org/doc', `from ${OGMIOS}/x and ogmios.test`];
    const body = { error: { code: 3010, message: 'Some scripts of the transactions terminated with error(s).', data: [{ validator: { index: 0, purpose: 'spend' }, error: { code: 3012, traces, more: 1 } }, { next: true }] } };
    const { error } = await raised(json(body, 400, 'Bad Request'));
    assert.ok(error instanceof OgmiosRpcError);
    assert.equal(error.dataTruncated, false);
    assert.deepEqual(JSON.parse(error.data!), [
      { validator: { index: 0, purpose: 'spend' }, error: { code: 3012, traces: ['see [endpoint]', 'from [endpoint] and [endpoint]'], more: 1 } },
      { next: true },
    ]);
  });

  test('a URL or a configured host in a KEY of the data is removed too, and the text stays JSON; keys that become equal are one key', async () => {
    const data = [{
      'https://ogmios.test:1337/internal': 1,
      nested: { 'koios.test': 'a', 'see http://submit.test:8090/api': ['b', { 'ogmios.test': true }] },
    }];
    const { error } = await raised(json({ error: { code: 3010, message: SCRIPTS_MESSAGE, data } }, 400, 'Bad Request'));
    assert.ok(error instanceof OgmiosRpcError && !error.dataTruncated && !error.dataDropped);
    assert.deepEqual(JSON.parse(error.data!), [{ '[endpoint]': 1, nested: { '[endpoint]': 'a', 'see [endpoint]': ['b', { '[endpoint]': true }] } }]);
    for (const secret of ['ogmios.test', 'koios.test', 'submit.test', '1337', '8090', 'http://']) assert.ok(!error.data!.includes(secret), `${secret} in ${error.data}`);
    const merged = await raised(json({ error: { code: 3010, message: 'm', data: { 'https://a.test/1': 'first', 'https://b.test/2': 'second' } } }, 400, 'Bad Request'));
    assert.equal((merged.error as OgmiosRpcError).data, '{"[endpoint]":"second"}');
  });

  test('a key named __proto__ stays a key of the data: the scrub sets no prototype', async () => {
    const { error } = await raised(withData('{"__proto__":{"polluted":"https://x.test/y"},"a":1}'));
    assert.ok(error instanceof OgmiosRpcError);
    assert.equal(error.data, '{"__proto__":{"polluted":"[endpoint]"},"a":1}');
    assert.equal(Reflect.get(Object.prototype, 'polluted'), undefined);
  });

  test('a data that is too deep is dropped, not thrown on: the same typed error, the message of old, data null (also at 5,000 and 100,000 levels, where JSON.stringify fails)', async () => {
    for (const status of [400, 200]) {
      for (const levels of [OGMIOS_ERROR_DATA_DEPTH_LIMIT + 1, 5_000, 100_000]) {
        assertDropped((await raised(withData(nestedArrays(levels), status))).error, messageOf(status), `${levels} levels of arrays, status ${status}`);
      }
      assertDropped((await raised(withData(nestedObjects(OGMIOS_ERROR_DATA_DEPTH_LIMIT + 1), status))).error, messageOf(status), `objects, status ${status}`);
      for (const kept of [nestedArrays(OGMIOS_ERROR_DATA_DEPTH_LIMIT), nestedObjects(OGMIOS_ERROR_DATA_DEPTH_LIMIT)]) {
        const { error } = await raised(withData(kept, status));
        assert.ok(error instanceof OgmiosRpcError);
        assert.deepEqual([error.data, error.dataDropped, error.dataTruncated], [kept, false, false], `a data of ${OGMIOS_ERROR_DATA_DEPTH_LIMIT} levels is kept (status ${status})`);
      }
    }
  });

  test('a data that is too large is dropped: at the limit it is read (and cut), one more character drops it, and each string, key and value counts', async () => {
    const text = (n: number) => JSON.stringify('x'.repeat(n));
    const { error: kept } = await raised(withData(text(OGMIOS_ERROR_DATA_INPUT_LIMIT - 1)));
    assert.ok(kept instanceof OgmiosRpcError);
    assert.deepEqual([kept.data!.length, kept.dataTruncated, kept.dataDropped], [OGMIOS_ERROR_DATA_LIMIT, true, false], 'a size of exactly the limit is read');
    const message = messageOf(400);
    assertDropped((await raised(withData(text(OGMIOS_ERROR_DATA_INPUT_LIMIT)))).error, message, 'one character more');
    assertDropped((await raised(withData(JSON.stringify({ ['k'.repeat(OGMIOS_ERROR_DATA_INPUT_LIMIT)]: 1 })))).error, message, 'a key counts');
    assertDropped((await raised(withData(JSON.stringify(Array.from({ length: OGMIOS_ERROR_DATA_INPUT_LIMIT }, () => 1))))).error, message, 'each value counts');
    assertDropped((await raised(withData(JSON.stringify(Array.from({ length: 200_000 }, (_, i) => `string ${i}`)), 200))).error, messageOf(200), 'many strings, status 200');
  });

  test('the read of a large data stops at the first excess: it does not touch a million strings or 300,000 values of an object', async () => {
    let reads = 0;
    const count = { get(target: object, key: string | symbol, receiver: unknown) { reads += 1; return Reflect.get(target, key, receiver); } };
    const strings = new Proxy(Array.from({ length: 1_000_000 }, () => 'abcd'), count);
    assertDropped((await raised(objectAnswer({ error: { code: 3010, message: SCRIPTS_MESSAGE, data: strings } }))).error, messageOf(200), 'a million strings');
    assert.ok(reads < 100_000, `${reads} reads of 1,000,000 elements`);
    reads = 0;
    const values = new Proxy(Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`key${i}`, 'v'])), count);
    assertDropped((await raised(objectAnswer({ error: { code: 3010, message: SCRIPTS_MESSAGE, data: values } }))).error, messageOf(200), '300,000 keys');
    assert.ok(reads < 100_000, `${reads} reads of 300,000 values`);
  });

  test('anything that fails while the text of the data is made leaves the error as it is, with data null: a getter that throws, a bigint, a function, a cycle', async () => {
    const getter = {};
    Object.defineProperty(getter, 'boom', { enumerable: true, get() { throw new Error('boom'); } });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const [why, data] of [['a getter that throws', getter], ['a bigint', 10n], ['a function', () => 1], ['a cycle', cycle]] as const) {
      const { error } = await raised(objectAnswer({ error: { code: 3010, message: SCRIPTS_MESSAGE, data } }));
      assertDropped(error, messageOf(200), why);
    }
  });

  test('the patterns that remove the endpoints are built once for each error, not for each string', async () => {
    const RealRegExp = globalThis.RegExp;
    let built = 0;
    globalThis.RegExp = new Proxy(RealRegExp, { construct(target, args, newTarget) { built += 1; return Reflect.construct(target, args, newTarget); } });
    let error: unknown;
    try {
      const data = Array.from({ length: 2_000 }, (_, i) => `string ${i} from ogmios.test`);
      ({ error } = await raised(objectAnswer({ error: { code: 3010, message: 'see ogmios.test', data } })));
    } finally {
      globalThis.RegExp = RealRegExp;
    }
    assert.ok(error instanceof OgmiosRpcError && !error.dataDropped);
    assert.ok(!error.data!.includes('ogmios.test') && !error.rpcMessage.includes('ogmios.test'), 'the removal ran for each string and for the message');
    assert.ok(built <= 3, `${built} patterns were built: one for each configured host, for the whole error`);
  });

  test('the message of the node is cut at 2,000 characters, as scrubUrls cuts a rejection: 2,000 stay whole, 2,001 are cut', async () => {
    const message = (n: number) => 'm'.repeat(n);
    const { error: whole } = await raised(json({ error: { code: 3010, message: message(2000) } }, 400, 'Bad Request'));
    const { error: cut } = await raised(json({ error: { code: 3010, message: message(2001) } }, 400, 'Bad Request'));
    assert.ok(whole instanceof OgmiosRpcError && cut instanceof OgmiosRpcError);
    assert.equal(whole.rpcMessage, message(2000));
    assert.equal(cut.rpcMessage, `${message(2000)} [truncated]`);
    assert.equal(scrubUrls(message(2000)), message(2000));
    assert.equal(scrubUrls(message(2001)), `${message(2000)} [truncated]`);
  });

  test('the data is cut at the limit, as JSON text, and the error says so', async () => {
    const big = { error: { code: 3010, message: 'Some scripts of the transactions terminated with error(s).', data: [{ traces: 'x'.repeat(OGMIOS_ERROR_DATA_LIMIT * 2) }] } };
    const { error } = await raised(json(big, 400, 'Bad Request'));
    assert.ok(error instanceof OgmiosRpcError);
    assert.equal(error.data!.length, OGMIOS_ERROR_DATA_LIMIT);
    assert.equal(error.dataTruncated, true);
    assert.equal(error.data, JSON.stringify(big.error.data).slice(0, OGMIOS_ERROR_DATA_LIMIT));
    const exact = { error: { code: 3010, message: 'm', data: 'y'.repeat(OGMIOS_ERROR_DATA_LIMIT - 2) } };
    const { error: whole } = await raised(json(exact, 400, 'Bad Request'));
    assert.ok(whole instanceof OgmiosRpcError);
    assert.deepEqual([whole.data!.length, whole.dataTruncated], [OGMIOS_ERROR_DATA_LIMIT, false], 'a text of exactly the limit is whole');
  });
});
