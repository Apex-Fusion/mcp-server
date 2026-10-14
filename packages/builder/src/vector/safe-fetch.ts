// packages/builder/src/vector/safe-fetch.ts
// Vendored from Apex-Fusion/vector-service-agents packages/vector-read/src/safe-fetch.ts @ 17c8527; keep the two copies identical.
// The only code path on the public server that fetches URLs taken from chain data
// (advert endpoint_url, detail_uri). Rules: https only, no credentials, hosts that
// resolve to a loopback, private, link-local, site-local, multicast, CGNAT, benchmarking
// (198.18.0.0/15), IETF protocol (192.0.0.0/24), class E (240.0.0.0/4) or unspecified
// range are refused. An IPv6 address in ::ffff:0:0/96 or 64:ff9b::/96 counts as the IPv4
// address inside it, and one in ::/96 is refused whatever it carries, in any spelling.
// Bodies are capped, redirects never change scheme, and the whole call has a budget: the
// host lookup is inside it.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SafeFetchOpts {
  maxResponseBytes?: number; timeoutMs?: number;
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  fetchImpl?: typeof fetch;
}
export const SAFE_FETCH_DEFAULTS = { maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 90_000 } as const;

export function assertSafeUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`safeFetch: malformed URL`); }
  if (u.protocol !== 'https:') throw new Error('safeFetch: only https URLs are allowed');
  if (u.username || u.password) throw new Error('safeFetch: credentials in URLs are not allowed');
  return u;
}

// The first three octets place an IPv4 address in every range below (the /24 needs the third).
const isPrivateV4 = (a: number, b: number, c: number) =>
  a === 0 // 0.0.0.0/8 this network, the unspecified address included
  || a === 10 // 10.0.0.0/8 private
  || a === 127 // 127.0.0.0/8 loopback
  || (a === 169 && b === 254) // 169.254.0.0/16 link-local
  || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12 private
  || (a === 192 && b === 168) // 192.168.0.0/16 private
  || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
  || (a === 192 && b === 0 && c === 0) // 192.0.0.0/24 IETF protocol assignments
  || (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15 benchmarking
  || (a >= 224 && a <= 239) // 224.0.0.0/4 multicast
  || a >= 240; // 240.0.0.0/4 class E, reserved for future use, and with it 255.255.255.255, the broadcast address

// The eight 16-bit groups of an IPv6 address in any spelling: zero compression, leading zeros, upper case, an embedded dotted quad, a zone suffix.
// Null when the text is not an IPv6 address. (A resolver may answer in any of these forms, not only the canonical one.)
function ipv6Groups(text: string): number[] | null {
  let s = text.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tailAt = s.lastIndexOf(':') + 1;
  if (s.slice(tailAt).includes('.')) { // a dotted quad at the end stands for two groups
    const quad = s.slice(tailAt);
    if (isIP(quad) !== 4) return null;
    const [a, b, c, d] = quad.split('.').map(Number);
    s = `${s.slice(0, tailAt)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN)));
  const head = groupsOf(halves[0]), rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  const gap = 8 - head.length - rest.length; // the zero groups that "::" stands for
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;
  const groups = [...head, ...Array<number>(Math.max(gap, 0)).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return isPrivateV4(a, b, c);
  }
  if (v === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true; // a form this function cannot read is not trusted
    const embedded = () => isPrivateV4(g[6] >> 8, g[6] & 0xff, g[7] >> 8); // the IPv4 address in the last 32 bits: g[6] holds its first two octets, g[7] the last two
    if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96: unspecified, loopback and the deprecated IPv4-compatible forms (::10.0.0.1)
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(); // IPv4-mapped (::ffff:10.0.0.1)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(); // NAT64 (64:ff9b::a00:1 is 10.0.0.1)
    return (g[0] & 0xfe00) === 0xfc00 // fc00::/7 unique local
      || (g[0] & 0xffc0) === 0xfe80 // fe80::/10 link-local
      || (g[0] & 0xffc0) === 0xfec0 // fec0::/10 site-local (deprecated)
      || (g[0] & 0xff00) === 0xff00; // ff00::/8 multicast
  }
  return true;
}

// Read the body, never holding more than `max` bytes. A content-length above the cap is refused before a
// single body byte is read. Otherwise the body is pulled chunk by chunk and abandoned (cancelled, so the
// connection is dropped) as soon as the running total passes the cap. A missing or malformed content-length
// is not above the cap, so the streamed count alone decides.
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`safeFetch: response of ${declared} bytes exceeds the ${max} byte cap`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`safeFetch: response of at least ${total} bytes exceeds the ${max} byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

// Settles like `work`, or rejects with the signal's reason the moment the signal fires: for the budget that is the TimeoutError that fetch would give.
// A lookup cannot be cancelled; it is only no longer waited for, and what it answers afterwards is dropped.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOpts = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const u = assertSafeUrl(url);
  // The budget starts here, before the host lookup, and covers it: a resolver that stalls is cut at timeoutMs like a fetch that stalls.
  // The timeout is combined with any signal the caller passed, never replaces it. (The caller's own signal reaches fetch, as before.)
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  // Residual risk (check-then-connect): the host is vetted by the lookup below and then resolved a second
  // time by fetch itself, so a hostile resolver could answer differently the second time. That gap is
  // bounded by https-only and certificate validation (the peer must still prove it is the vetted hostname).
  // Pinning the vetted address would need an undici dispatcher with its own connect step; ruled out.
  const lookup = opts.lookup ?? (async (h: string) => dnsLookup(h, { all: true }));
  // URL.hostname keeps the brackets of an IPv6 literal ("[::1]"), and isIP does not know that form: strip them so a literal is judged directly.
  const literal = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  const addrs = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await untilAborted(Promise.resolve(lookup(u.hostname)), timeout);
  if (addrs.length === 0) throw new Error(`safeFetch: ${u.hostname} does not resolve`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`safeFetch: ${u.hostname} resolves to a private or reserved address; refused`);
  const f = opts.fetchImpl ?? fetch;
  const res = await f(u.toString(), { ...init, redirect: 'manual', signal });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    await res.body?.cancel().catch(() => {});
    throw new Error(`safeFetch: redirect to ${loc || '(no location)'} refused (redirects are not followed)`);
  }
  const buf = await readCapped(res, opts.maxResponseBytes ?? SAFE_FETCH_DEFAULTS.maxResponseBytes);
  return { status: res.status, headers: res.headers, text: buf.toString('utf8') };
}
