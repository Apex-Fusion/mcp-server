// packages/builder/src/vector/safe-fetch.ts
// Vendored from Apex-Fusion/vector-service-agents packages/vector-read/src/safe-fetch.ts @ f3b50e9; keep the two copies identical.
// The only code path on the public server that fetches URLs taken from chain data
// (advert endpoint_url, detail_uri). Rules: https only, no credentials, hosts that
// resolve to loopback/private/link-local/CGNAT/unspecified ranges are refused,
// bodies are capped, redirects never change scheme, and the whole call has a budget.
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

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice(7));
    const first = parseInt(low.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
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

export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOpts = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const u = assertSafeUrl(url);
  // Residual risk (check-then-connect): the host is vetted by the lookup below and then resolved a second
  // time by fetch itself, so a hostile resolver could answer differently the second time. That gap is
  // bounded by https-only and certificate validation (the peer must still prove it is the vetted hostname).
  // Pinning the vetted address would need an undici dispatcher with its own connect step; ruled out.
  const lookup = opts.lookup ?? (async (h: string) => dnsLookup(h, { all: true }));
  const addrs = isIP(u.hostname) ? [{ address: u.hostname, family: isIP(u.hostname) }] : await lookup(u.hostname);
  if (addrs.length === 0) throw new Error(`safeFetch: ${u.hostname} does not resolve`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`safeFetch: ${u.hostname} resolves to a private or reserved address; refused`);
  const f = opts.fetchImpl ?? fetch;
  // The timeout is combined with any signal the caller passed, never replaces it.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const res = await f(u.toString(), { ...init, redirect: 'manual', signal });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    await res.body?.cancel().catch(() => {});
    throw new Error(`safeFetch: redirect to ${loc || '(no location)'} refused (redirects are not followed)`);
  }
  const buf = await readCapped(res, opts.maxResponseBytes ?? SAFE_FETCH_DEFAULTS.maxResponseBytes);
  return { status: res.status, headers: res.headers, text: buf.toString('utf8') };
}
