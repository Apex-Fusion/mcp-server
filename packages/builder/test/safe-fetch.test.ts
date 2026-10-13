// packages/builder/test/safe-fetch.test.ts
// Ported from the vitest suite of Apex-Fusion/vector-service-agents (packages/vector-read/test/safe-fetch.test.ts @ f3b50e9) to
// node:test + node:assert/strict; every assertion keeps its meaning. The module under test is vendored from that repo too.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../src/vector/safe-fetch.ts';

describe('safeFetch policy', () => {
  test('refuses non-https', () => { assert.throws(() => assertSafeUrl('http://example.com/x'), /https/); });
  test('refuses credentials in the URL', () => { assert.throws(() => assertSafeUrl('https://user:pw@example.com/'), /credentials/); });
  test('classifies private and special ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });
  test('refuses a host that resolves to a private address', async () => {
    const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    await assert.rejects(() => safeFetch('https://metadata.example/', {}, { lookup, fetchImpl: (async () => new Response('x')) as any }), /private/);
  });
  test('caps the response size', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const big = 'a'.repeat(5000);
    await assert.rejects(() => safeFetch('https://ok.example/', {}, { lookup, maxResponseBytes: 1000, fetchImpl: (async () => new Response(big)) as any }), /exceeds/);
  });
  test('refuses cross-scheme redirects', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const f = (async () => new Response('', { status: 302, headers: { location: 'http://evil.example/' } })) as any;
    await assert.rejects(() => safeFetch('https://ok.example/', {}, { lookup, fetchImpl: f }), /redirect/);
  });
  // Additions of the vector-service-agents suite: the six tests above have no success path and never check that redirect: 'manual' reaches fetch.
  test('passes the caller init through with redirect: manual and returns status, headers and text', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    let seen: RequestInit | undefined;
    const f = (async (_u: any, init?: RequestInit) => { seen = init; return new Response('hello', { status: 200, headers: { 'x-k': 'v' } }); }) as any;
    const res = await safeFetch('https://ok.example/p', { method: 'POST', body: 'req' }, { lookup, fetchImpl: f });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'hello');
    assert.equal(res.headers.get('x-k'), 'v');
    assert.equal(seen?.redirect, 'manual');
    assert.equal(seen?.method, 'POST');
    assert.equal(seen?.body, 'req');
    assert.ok(seen?.signal instanceof AbortSignal, 'a signal reaches fetch');
  });
  test('checks an IP-literal host directly, without a lookup', async () => {
    const lookup = async () => { throw new Error('lookup must not be called'); };
    const f = (async () => new Response('x')) as any;
    await assert.rejects(() => safeFetch('https://169.254.169.254/latest/meta-data', {}, { lookup, fetchImpl: f }), /private/);
  });
});

// Hardening (made in vector-service-agents first, vendored here): the byte cap must hold while the body streams in, not after
// the whole body has been buffered, because safeFetch is pointed at endpoints a registrant controls.
describe('safeFetch body cap and abort handling', () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const URL_ = 'https://ok.example/';
  // A pull-driven body of the given chunk sizes that counts pulls and notes a cancel.
  const countedBody = (sizes: number[], strategy?: QueuingStrategy<Uint8Array>) => {
    const seen = { pulls: 0, cancelled: false };
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { seen.pulls++; if (next < sizes.length) c.enqueue(new Uint8Array(sizes[next++]).fill(97)); else c.close(); },
      cancel() { seen.cancelled = true; },
    }, strategy);
    return { body, seen };
  };

  test('stops reading and cancels the body once the running total passes the cap', async () => {
    const { body, seen } = countedBody(Array(100).fill(1_000));
    const f = (async () => new Response(body)) as any;
    await assert.rejects(() => safeFetch(URL_, {}, { lookup, maxResponseBytes: 2_500, fetchImpl: f }), /exceeds the 2500 byte cap/);
    assert.ok(seen.pulls <= 4, `${seen.pulls} pulls`);
    assert.equal(seen.cancelled, true);
  });

  test('refuses a content-length above the cap before pulling any body byte', async () => {
    // highWaterMark 0: no look-ahead, so a pull can only come from a read of the body
    const { body, seen } = countedBody(Array(100).fill(1_000), { highWaterMark: 0 });
    const f = (async () => new Response(body, { headers: { 'content-length': '10000' } })) as any;
    await assert.rejects(() => safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: f }), /response of 10000 bytes exceeds the 1000 byte cap/);
    assert.equal(seen.pulls, 0);
    assert.equal(seen.cancelled, true);
  });

  test('a refused redirect cancels its unread body instead of leaving the connection open', async () => {
    // highWaterMark 0: no look-ahead, so a pull can only come from a read of the body
    const { body, seen } = countedBody(Array(100).fill(1_000), { highWaterMark: 0 });
    const f = (async () => new Response(body, { status: 302, headers: { location: 'http://evil.example/' } })) as any;
    await assert.rejects(() => safeFetch(URL_, {}, { lookup, fetchImpl: f }), /redirect/);
    assert.equal(seen.pulls, 0);
    assert.equal(seen.cancelled, true);
  });

  test('a body of exactly the cap resolves, one byte more does not', async () => {
    const plain = await safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: (async () => new Response('a'.repeat(1_000))) as any });
    assert.equal(plain.text, 'a'.repeat(1_000));
    // streamed in two chunks with an honest content-length: neither the header check nor the running total may trip
    const exact = countedBody([500, 500]);
    const ok = await safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: (async () => new Response(exact.body, { headers: { 'content-length': '1000' } })) as any });
    assert.equal(ok.text, 'a'.repeat(1_000));
    assert.equal(exact.seen.cancelled, false);
    const over = countedBody([500, 501, 500]); // a third chunk keeps the source open, so there is something left to cancel
    await assert.rejects(() => safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: (async () => new Response(over.body)) as any }), /exceeds/);
    assert.equal(over.seen.cancelled, true);
  });

  test('a null body (204) yields empty text, and multi-byte text split across chunks survives', async () => {
    const empty = await safeFetch(URL_, {}, { lookup, fetchImpl: (async () => new Response(null, { status: 204 })) as any });
    assert.equal(empty.status, 204);
    assert.equal(empty.text, '');
    const euro = new TextEncoder().encode('€uro'); // 0xE2 0x82 0xAC then ASCII: split inside the first character
    const split = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(euro.slice(0, 1)); c.enqueue(euro.slice(1, 2)); c.enqueue(euro.slice(2)); c.close(); } }));
    assert.equal((await safeFetch(URL_, {}, { lookup, fetchImpl: (async () => split) as any })).text, '€uro');
  });

  test('an already-aborted caller signal reaches fetch and makes safeFetch reject', async () => {
    const ac = new AbortController();
    ac.abort(new Error('caller gave up'));
    let received: AbortSignal | undefined;
    // behave like fetch: refuse to start on an aborted signal
    const f = (async (_u: any, init?: RequestInit) => { received = init?.signal ?? undefined; init?.signal?.throwIfAborted(); return new Response('x'); }) as any;
    await assert.rejects(() => safeFetch(URL_, { signal: ac.signal }, { lookup, fetchImpl: f }), { message: /caller gave up/ });
    assert.equal(received?.aborted, true);
  });

  test('a caller signal does not displace the timeout, and aborting it mid-call still stops the call', async () => {
    // a fetch that never answers and rejects with the signal reason, as the real one does
    const hang = (entered = () => {}) => (async (_u: any, init?: RequestInit) => new Promise((_ok, fail) => {
      const s = init!.signal!;
      if (s.aborted) return fail(s.reason);
      s.addEventListener('abort', () => fail(s.reason), { once: true });
      entered();
    })) as any;
    await assert.rejects(() => safeFetch(URL_, { signal: new AbortController().signal }, { lookup, timeoutMs: 20, fetchImpl: hang() }), { name: 'TimeoutError' });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const ac = new AbortController();
    const pending = safeFetch(URL_, { signal: ac.signal }, { lookup, fetchImpl: hang(entered) });
    await started;
    ac.abort(new Error('caller stopped it'));
    await assert.rejects(() => pending, { message: /caller stopped it/ });
  });
});
