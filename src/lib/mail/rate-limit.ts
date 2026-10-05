/** Token bucket in quota units per minute. Gmail: run at 80% of the per-user limit (00-brief §5). */
export class UnitBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
  }

  async take(units: number) {
    for (;;) {
      this.refill();
      if (this.tokens >= units) {
        this.tokens -= units;
        return;
      }
      await this.sleep(Math.ceil(((units - this.tokens) / this.perMinute) * 60_000));
    }
  }
}

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("rate_limited");
  }
}

/** Backoff for 429 / 403 rateLimitExceeded: honour Retry-After, else exponential with jitter. */
export function backoffMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(retryAfterHeader);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(64_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
}
