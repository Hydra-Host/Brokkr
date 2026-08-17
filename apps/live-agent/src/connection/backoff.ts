export interface BackoffConfig {
  initial_ms: number;
  max_ms: number;
  min_ms?: number;
}

export class Backoff {
  private attempt = 0;

  constructor(private cfg: BackoffConfig) {}

  next(): number {
    const base = Math.min(this.cfg.max_ms, this.cfg.initial_ms * 2 ** this.attempt);
    this.attempt += 1;
    return Math.max(this.cfg.min_ms ?? 0, Math.floor(Math.random() * base));
  }

  reset(): void {
    this.attempt = 0;
  }
}
