// packages/builder/src/vector/marketplace-shared.ts
// What every marketplace tool family shares: the text result and the failure text, the escaping for text that comes out of adverts
// and datums, the signer hand-off sentence, and the rate-limit gate. The gate takes its limiter as an argument, so a test can hand
// in its own; marketplace.ts is where the caller's limiter is chosen.
import type { RateLimiter } from './rate-limiter.js';
import { ACCEPT_WINDOW_MS } from './marketplace-constants.js';

export function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
/** Long enough for the longest refusal a builder writes (a list of five refs and its explanation), short enough to bound what an error can say. */
const ERROR_TEXT_MAX = 800;
export function fail(what: string, err: unknown, tips: string[]) {
  // The message can carry text out of a datum or an advert, which anyone can write: it is shown flattened to one escaped line.
  return text(`Failed to ${what}: ${cell(err instanceof Error ? err.message : String(err), ERROR_TEXT_MAX)}\n\n**Troubleshooting Tips:**\n${tips.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
}
export function host(url: string): string { try { return new URL(url).host; } catch { return url; } }
/**
 * Supplier-controlled text headed for a markdown table, bullet or heading: one line, no pipes or backticks, at most
 * `max` characters. Adverts are written by anyone, so an unescaped value could break the table or smuggle lines into
 * the assistant's context. The fenced JSON block carries the verbatim value.
 */
export function cell(s: unknown, max = 80): string {
  const flat = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\|/g, '¦').replace(/`/g, "'").trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : flat;
}
export function isoOrRaw(ms: number): string { const d = new Date(ms); return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString(); }

/** The accept window, in seconds. */
export const ACCEPT_WINDOW_S = ACCEPT_WINDOW_MS / 1000;
/** What a missed accept window costs, in the one wording every tool uses. escrow.ak (handle_release) only bounds the supplier's take from below (the three amounts the datum names), so it may keep the floor excess of the lock as well. */
export const RELEASE_TAKE = 'keep everything locked (price + both bonds + any floor excess)';
/** The accept clock, as one sentence for every text that has to carry it. */
export const ACCEPT_CLOCK = `Accept must land within ${ACCEPT_WINDOW_S} s of the supplier's Submit; after that the supplier may Release and ${RELEASE_TAKE}.`;

export const SIGN_COPY = 'Sign it locally with vector_signer_sign { txCbor }, broadcast with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';

/** What a handler asks before it does anything: null to go on, or the refusal to return as the answer. */
export type RateGate = () => ReturnType<typeof text> | null;
/** The gate for one caller's limiter (the limiter may be anything with a `check`, so a test can pass a small one). */
export function rateGate(limiter: Pick<RateLimiter, 'check'>): RateGate {
  return () => {
    const r = limiter.check();
    return r.allowed ? null : text(`Rate limit exceeded. Retry after ${r.retryAfterMs}ms.`);
  };
}
