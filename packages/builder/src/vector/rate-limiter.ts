// Sliding-window rate limiter for Vector MCP tools

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

const RATE_LIMIT_PER_MINUTE = parseInt(process.env.VECTOR_RATE_LIMIT_PER_MINUTE || '60');

// One bucket per identity. A process-global limiter meant one busy caller
// throttled everyone on the box; keying by identity fixes that. The registry
// is keyed rather than per-connection so a caller cannot reset its own budget
// by reconnecting.
const limiters = new Map<string, RateLimiter>();

export function limiterFor(identity: string): RateLimiter {
  let limiter = limiters.get(identity);
  if (!limiter) {
    limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);
    limiters.set(identity, limiter);
  }
  return limiter;
}

/** Test-only. Clears every bucket. */
export function resetLimiters(): void {
  limiters.clear();
}
