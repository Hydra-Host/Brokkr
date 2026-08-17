/** Single-flight cache: dedupes concurrent loads, caches the result, and invalidates by generation.
 *  A load that straddled an invalidate() never commits — it can't arm the cooldown nor clear a successor's in-flight slot. */
export interface SingleFlightCacheOptions<T> {
  /** The expensive load. Runs at most once concurrently; must throw on failure. */
  load: () => Promise<T>;
  /** Success TTL in ms; omit to cache until `invalidate()`. */
  ttlMs?: number;
  /** Negatively-cache a failure for this long; omit for no cooldown (errors propagate every call). */
  cooldownMs?: number;
  /** Value to serve on failure / while cooling down; omit to throw instead. */
  degrade?: () => T;
  /** Error message thrown while cooling down when there's no `degrade`. */
  cooldownMessage?: string;
  /** Reload attempts when the generation is bumped mid-flight (default 1 = serve the uncached result). */
  maxAttempts?: number;
  /** Error thrown when the generation keeps moving across all `maxAttempts`. */
  staleMessage?: string;
  /** Side-effect (logging) invoked once per caught load failure. */
  onError?: (error: unknown) => void;
}

export class SingleFlightCache<T> {
  private cached: { value: T; at: number } | null = null;
  private inFlight: Promise<T> | null = null;
  private retryAfter = 0;
  // bumped on every invalidation; a load that began under an older gen must not commit its result.
  private gen = 0;
  private readonly maxAttempts: number;

  constructor(private readonly opts: SingleFlightCacheOptions<T>) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
  }

  async get(): Promise<T> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const hit = this.peek();
      if (hit) return hit.value;
      if (this.coolingDown()) return this.degradeOrThrow();
      const gen = this.gen;
      const inFlight = this.inFlight ?? this.run(gen); // share a running load
      this.inFlight = inFlight;
      let value: T;
      try {
        value = await inFlight;
      } finally {
        // only clear if still ours — invalidate() may have nulled it to force a fresh load
        if (this.inFlight === inFlight) this.inFlight = null;
      }
      if (gen === this.gen || this.maxAttempts === 1) return value;
      // generation moved under us — retry to return a current-generation value
    }
    throw new Error(this.opts.staleMessage ?? 'value kept changing under concurrent invalidations');
  }

  /** Run an out-of-band load NOW (bypassing cache/cooldown/in-flight) and commit it under the same
   *  generation guard, so the cache serves the fresh value afterward. Failures propagate, never arming the cooldown. */
  async prime(load: () => Promise<T>): Promise<T> {
    const gen = this.gen;
    const value = await load();
    if (gen === this.gen) {
      this.cached = { value, at: Date.now() };
      this.retryAfter = 0;
      // supersede any in-flight load: it began before this primed value, so run()'s gen guard now
      // rejects its completion (waiters still get their value; multi-attempt callers hit the primed cache).
      this.gen++;
      this.inFlight = null;
    }
    return value;
  }

  /** Drop any cached value + in-flight load and bump the generation, so the next `get()` reloads and
   *  a load already in flight can neither commit its (now-stale) result nor be shared. */
  invalidate(): void {
    this.gen++;
    this.cached = null;
    this.retryAfter = 0;
    this.inFlight = null;
  }

  private peek(): { value: T } | null {
    if (!this.cached) return null;
    if (this.opts.ttlMs !== undefined && Date.now() - this.cached.at >= this.opts.ttlMs) return null;
    return { value: this.cached.value };
  }

  private coolingDown(): boolean {
    return this.opts.cooldownMs !== undefined && Date.now() < this.retryAfter;
  }

  private degradeOrThrow(): T {
    if (this.opts.degrade) return this.opts.degrade();
    throw new Error(this.opts.cooldownMessage ?? 'value temporarily unavailable (cooling down)');
  }

  private async run(gen: number): Promise<T> {
    try {
      const value = await this.opts.load();
      // drop a load that straddled an invalidate() — it read a pre-invalidation source.
      if (gen === this.gen) {
        this.cached = { value, at: Date.now() };
        this.retryAfter = 0;
      }
      return value;
    } catch (error) {
      if (this.opts.cooldownMs !== undefined && gen === this.gen) this.retryAfter = Date.now() + this.opts.cooldownMs;
      this.opts.onError?.(error);
      if (this.opts.degrade) return this.opts.degrade();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
