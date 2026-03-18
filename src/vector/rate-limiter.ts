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
export const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);
