// packages/builder/test/safe-fetch.test.ts
// Ported from the vitest suite of Apex-Fusion/vector-service-agents (packages/vector-read/test/safe-fetch.test.ts @ cfd036e) to
// node:test + node:assert/strict; every assertion keeps its meaning. The module under test is vendored from that repo too. That suite also
// has a describe local to its repo (what specs/agent-history.md says safeFetch refuses) that reads a document of that repo: not ported;
// the address kinds it names are all pinned below and above.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../src/vector/safe-fetch.ts';
import { heldOpen } from './fixtures/held-open.ts';

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
    await assert.rejects(() => heldOpen(safeFetch(URL_, { signal: new AbortController().signal }, { lookup, timeoutMs: 20, fetchImpl: hang() })), { name: 'TimeoutError' });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const ac = new AbortController();
    const pending = safeFetch(URL_, { signal: ac.signal }, { lookup, fetchImpl: hang(entered) });
    await started;
    ac.abort(new Error('caller stopped it'));
    await assert.rejects(() => pending, { message: /caller stopped it/ });
  });
});

// Hardening made in vector-service-agents first (E1 to E3 of its final-review batch), vendored here: the budget covers the host lookup,
// and an address is judged by its range in whatever spelling it arrives. Injected lookup and fetch only, no network.
describe('safeFetch: the budget covers the host lookup', () => {
  const ok = (async () => new Response('x')) as any;
  test('a lookup that never answers is cut at the timeout with the same TimeoutError, and fetch is never reached', async () => {
    let fetched = false;
    const lookup = () => new Promise<never>(() => {});
    const f = (async () => { fetched = true; return new Response('x'); }) as any;
    const t0 = performance.now();
    await assert.rejects(() => heldOpen(safeFetch('https://slow.example/', {}, { lookup, timeoutMs: 30, fetchImpl: f })), { name: 'TimeoutError' });
    assert.ok(performance.now() - t0 < 2_000, 'it did not wait for a resolver that never answers');
    assert.equal(fetched, false);
  });
  test('the lookup and the fetch share one budget: a slow lookup leaves the fetch what is left of it', async () => {
    const lookup = () => new Promise<Array<{ address: string; family: number }>>((resolve) => setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 300));
    // a fetch that never answers and rejects with the signal reason, as the real one does
    const hang = (async (_u: any, init?: RequestInit) => new Promise((_ok, fail) => { const s = init!.signal!; if (s.aborted) fail(s.reason); s.addEventListener('abort', () => fail(s.reason), { once: true }); })) as any;
    const t0 = performance.now();
    await assert.rejects(() => heldOpen(safeFetch('https://slow.example/', {}, { lookup, timeoutMs: 600, fetchImpl: hang })), { name: 'TimeoutError' });
    const ms = performance.now() - t0;
    assert.ok(ms >= 520, `${ms} ms: the whole budget was used`);
    assert.ok(ms < 850, `${ms} ms: and not the lookup time on top of it (300 + 600)`);
  });
  test('a lookup that fails or answers after the budget is dropped: no unhandled rejection, no fetch', async () => {
    let fetched = false;
    const lookup = () => new Promise<never>((_ok, fail) => setTimeout(() => fail(new Error('the resolver answered late')), 80));
    const f = (async () => { fetched = true; return new Response('x'); }) as any;
    await assert.rejects(() => safeFetch('https://slow.example/', {}, { lookup, timeoutMs: 20, fetchImpl: f }), { name: 'TimeoutError' });
    await new Promise((r) => setTimeout(r, 200)); // the late failure arrives; the test run fails if it is unhandled
    assert.equal(fetched, false);
  });
  test('a lookup that answers in time is untouched by the budget; the host is what the lookup was asked for', async () => {
    const asked: string[] = [];
    const lookup = async (h: string) => { asked.push(h); return [{ address: '8.8.8.8', family: 4 }]; };
    const res = await safeFetch('https://ok.example/p', {}, { lookup, timeoutMs: 5_000, fetchImpl: ok });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'x');
    assert.deepEqual(asked, ['ok.example']);
  });
});

describe('safeFetch: IPv6 literals are judged directly, with no lookup', () => {
  const mustNotLookUp = async () => { throw new Error('lookup must not be called for an address literal'); };
  const reached = () => { const urls: string[] = []; return { urls, f: (async (u: any) => { urls.push(String(u)); return new Response('x'); }) as any }; };
  test('URL.hostname keeps the brackets, and a literal of a private or special range is refused all the same', async () => {
    assert.equal(new URL('https://[::1]/').hostname, '[::1]'); // the reason for stripping them
    for (const host of ['[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[fec0::1]', '[ff02::1]', '[::ffff:10.0.0.1]', '[::ffff:a9fe:a9fe]', '[::10.0.0.1]', '[64:ff9b::a00:1]', '[0:0:0:0:0:0:0:1]']) {
      const { urls, f } = reached();
      await assert.rejects(() => safeFetch(`https://${host}/x`, {}, { lookup: mustNotLookUp, fetchImpl: f }), /private/, host);
      assert.deepEqual(urls, [], host);
    }
  });
  test('a public IPv6 literal, and one that maps or translates to a public IPv4 address, goes straight to fetch', async () => {
    for (const host of ['[2606:4700::1111]', '[2001:4860:4860::8888]', '[::ffff:8.8.8.8]', '[64:ff9b::808:808]']) {
      const { urls, f } = reached();
      assert.equal((await safeFetch(`https://${host}/p`, {}, { lookup: mustNotLookUp, fetchImpl: f })).status, 200, host);
      assert.equal(urls.length, 1, host);
    }
  });
  test('an address that comes back from the lookup is judged in whatever form the resolver gives it', async () => {
    for (const address of ['0:0:0:0:0:0:0:1', '::0001', '0:0:0:0:0:ffff:10.0.0.1', '::FFFF:A00:1', '::10.0.0.1', '64:ff9b::a00:1', 'FEC0::1', 'FF02::1']) {
      const lookup = async () => [{ address, family: 6 }];
      await assert.rejects(() => safeFetch('https://sneaky.example/', {}, { lookup, fetchImpl: (async () => new Response('x')) as any }), /private/, address);
    }
    // One private answer among public ones is enough to refuse the host.
    const mixed = async () => [{ address: '2606:4700::1111', family: 6 }, { address: '::ffff:10.0.0.1', family: 6 }];
    await assert.rejects(() => safeFetch('https://sneaky.example/', {}, { lookup: mixed, fetchImpl: (async () => new Response('x')) as any }), /private/);
  });
});

describe('isPrivateAddress reads every spelling of an IPv6 address', () => {
  test('loopback and unspecified, written out, padded or compressed', () => {
    for (const ip of ['::1', '0:0:0:0:0:0:0:1', '::0001', '0000:0000:0000:0000:0000:0000:0000:0001', '::', '0:0:0:0:0:0:0:0', '0::0']) assert.equal(isPrivateAddress(ip), true, ip);
  });
  test('an IPv4 address inside an IPv6 one counts as that IPv4 address: mapped, compatible and NAT64, dotted or in hex', () => {
    for (const ip of ['::ffff:10.0.0.1', '0:0:0:0:0:ffff:10.0.0.1', '::FFFF:A00:1', '::ffff:7f00:1', '::ffff:c0a8:101', '::ffff:ac10:1', '::ffff:a9fe:a9fe', '::ffff:6440:1', '::10.0.0.1', '::a00:1', '::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1', '0064:ff9b:0:0:0:0:a00:1', '64:ff9b::7f00:1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '::ffff:172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
  });
  test('unique-local, link-local, site-local and multicast, in either case and with or without a zone', () => {
    for (const ip of ['fc00::1', 'fd00::1', 'FD00::1', 'fdff::1', 'fd00:0:0:0:0:0:0:1', 'fe80::1', 'FE80::1', 'febf::1', 'fe80::1%eth0', 'fec0::1', 'feff::1', 'ff00::', 'ff02::1', 'FF05::2']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::', '2000::1', '3fff::1', 'fbff::1', 'fe7f::1']) assert.equal(isPrivateAddress(ip), false, ip);
  });
  test('text that is not an address is refused, and the IPv4 rules are as they were', () => {
    for (const ip of ['', 'localhost', '[::1]', '1.2.3', '::g', '1:2:3:4:5:6:7:8:9', '1::2::3', 'example.com']) assert.equal(isPrivateAddress(ip), true, JSON.stringify(ip));
    for (const ip of ['0.0.0.0', '10.1.2.3', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.253.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

describe('safeFetch keeps its own redirect policy', () => {
  test('a caller redirect option cannot defeat redirect: manual, because the module\'s own init wins', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const seen: Array<RequestInit | undefined> = [];
    const f = (async (_u: any, init?: RequestInit) => { seen.push(init); return new Response('', { status: 302, headers: { location: 'http://evil.example/' } }); }) as any;
    for (const redirect of ['follow', 'error'] as const) {
      await assert.rejects(() => safeFetch('https://ok.example/', { redirect }, { lookup, fetchImpl: f }), /redirect/, redirect);
      assert.equal(seen.at(-1)?.redirect, 'manual', redirect);
    }
    assert.equal(seen.length, 2);
  });
});
