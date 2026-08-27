export type BackoffConfig = { initial_ms: number; max_ms: number; min_ms?: number; factor?: number };

export class Backoff {
  private attempt = 0;

  constructor(private cfg: BackoffConfig) {}

  next(): number {
    const attempt = this.attempt;
    this.attempt += 1;
    const factor = this.cfg.factor ?? 2;
    const base = Math.min(this.cfg.max_ms, this.cfg.initial_ms * factor ** attempt);
    return Math.max(this.cfg.min_ms ?? 0, Math.floor(Math.random() * base));
  }

  reset(): void {
    this.attempt = 0;
  }
}
