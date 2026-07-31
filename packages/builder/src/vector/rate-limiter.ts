// Sliding-window rate limiter for Vector MCP tools

import { intEnv } from '../env.js';

export class RateLimiter {
  private calls: number[] = [];
  private readonly windowMs: number;
  private readonly maxCalls: number;

  constructor(perMinute = 60) {
    this.windowMs = 60_000;
    this.maxCalls = perMinute;
  }

  check(): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    // Evict calls outside the window
    this.calls = this.calls.filter(t => now - t < this.windowMs);
    if (this.calls.length >= this.maxCalls) {
      const oldest = this.calls[0];
      return { allowed: false, retryAfterMs: this.windowMs - (now - oldest) };
    }
    this.calls.push(now);
    return { allowed: true };
  }
}

// Parsed with intEnv (env.ts), not a bare parseInt: a malformed value must
// fail loud at startup, not silently disable rate limiting. parseInt('sixty')
// is NaN, and RateLimiter.check() above compares `calls.length >= maxCalls` -
// any comparison against NaN is false, so a typo here would have let every
// caller through with no limit at all, silently. Exported so index.ts's
// startup log can report the effective value operators are actually running
// under, alongside the /mcp session knobs.
export const RATE_LIMIT_PER_MINUTE = intEnv('VECTOR_RATE_LIMIT_PER_MINUTE', 60, 1);

// One bucket per identity. A process-global limiter meant one busy caller
// throttled everyone on the box; keying by identity fixes that. The registry
// is keyed rather than per-connection so a caller cannot reset its own budget
// by reconnecting.
const limiters = new Map<string, RateLimiter>();

/**
 * Upper bound on tracked identities. Per-IP anonymous buckets mean a public
 * instance can see unbounded distinct identities; without a cap that is an
 * unbounded-memory vector. FIFO-with-refresh (Map insertion order, re-inserted
 * on access) approximates LRU. Eviction RESETS that identity's budget - a
 * deliberate memory-bound trade, not a security boundary: rotating thousands
 * of source addresses defeats per-IP limiting at a tier only the proxy or
 * network layer can police.
 */
export const MAX_TRACKED_IDENTITIES = 4096;

export function limiterFor(identity: string): RateLimiter {
  let limiter = limiters.get(identity);
  if (limiter) {
    limiters.delete(identity);
    limiters.set(identity, limiter); // refresh recency
    return limiter;
  }
  limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);
  if (limiters.size >= MAX_TRACKED_IDENTITIES) {
    const oldest = limiters.keys().next().value;
    if (oldest !== undefined) limiters.delete(oldest);
  }
  limiters.set(identity, limiter);
  return limiter;
}

/** Test-only. Clears every bucket. */
export function resetLimiters(): void {
  limiters.clear();
}
