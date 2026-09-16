import type { RedisDriver, RedisDriverPipeline } from '../redis-driver';

interface Entry {
  value: string;
  expiresAt: number | null;
}

interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export class FakeCasRedis implements RedisDriver {
  private readonly store = new Map<string, Entry>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly streams = new Map<string, StreamEntry[]>();
  private readonly streamExpiry = new Map<string, number>();
  private seq = 0;
  now = 0;
  failNextCommand: Error | null = null;
  failNextEval: Error | null = null;
  pingErrors = 0;

  advance(seconds: number): void {
    this.now += seconds;
  }

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private liveStream(key: string): StreamEntry[] | undefined {
    const entries = this.streams.get(key);
    if (!entries) return undefined;
    const expiresAt = this.streamExpiry.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now) {
      this.streams.delete(key);
      this.streamExpiry.delete(key);
      return undefined;
    }
    return entries;
  }

  streamEntries(key: string): StreamEntry[] {
    return this.liveStream(key) ?? [];
  }

  private maybeFailCommand(): void {
    if (this.failNextCommand) {
      const err = this.failNextCommand;
      this.failNextCommand = null;
      throw err;
    }
  }

  async ping(): Promise<unknown> {
    if (this.pingErrors > 0) {
      this.pingErrors -= 1;
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    }
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    this.maybeFailCommand();
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.maybeFailCommand();
    this.store.set(key, { value, expiresAt: null });
    return 'OK';
  }

  async setex(key: string, ttl: number, value: string): Promise<unknown> {
    this.maybeFailCommand();
    this.store.set(key, { value, expiresAt: this.now + ttl });
    return 'OK';
  }

  async setNx(key: string, value: string, ttl?: number): Promise<boolean> {
    this.maybeFailCommand();
    if (this.live(key)) return false;
    this.store.set(key, { value, expiresAt: ttl !== undefined && ttl > 0 ? this.now + ttl : null });
    return true;
  }

  async del(key: string): Promise<number> {
    this.maybeFailCommand();
    const existed = this.live(key) !== undefined || this.liveStream(key) !== undefined;
    this.store.delete(key);
    this.streams.delete(key);
    this.streamExpiry.delete(key);
    return existed ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    this.maybeFailCommand();
    return this.live(key) || this.liveStream(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.maybeFailCommand();
    const entry = this.live(key);
    if (entry) {
      entry.expiresAt = this.now + seconds;
      return 1;
    }
    if (this.liveStream(key)) {
      this.streamExpiry.set(key, this.now + seconds);
      return 1;
    }
    return 0;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (this.failNextEval) {
      const err = this.failNextEval;
      this.failNextEval = null;
      throw err;
    }
    const key = keys[0];
    const token = args[0];
    if (script.includes('"NX"')) {
      const ttl = Number(args[1]);
      const existing = this.live(key);
      if (!existing) {
        this.store.set(key, { value: token, expiresAt: this.now + ttl });
        return 1;
      }
      return existing.value === token ? 1 : 0;
    }
    if (script.includes('expire')) {
      const entry = this.live(key);
      if (entry && entry.value === token) {
        entry.expiresAt = this.now + Number(args[1]);
        return 1;
      }
      return 0;
    }
    if (script.includes('del')) {
      const entry = this.live(key);
      if (entry && entry.value === token) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    throw new Error(`unmodeled eval script: ${script}`);
  }

  async hset(key: string, mapping: Record<string, string>): Promise<number> {
    this.maybeFailCommand();
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    let added = 0;
    for (const [field, value] of Object.entries(mapping)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, value);
    }
    this.hashes.set(key, hash);
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.maybeFailCommand();
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.maybeFailCommand();
    const hash = this.hashes.get(key);
    return hash ? Object.fromEntries(hash) : {};
  }

  async rpush(key: string, values: string[]): Promise<number> {
    this.maybeFailCommand();
    void key;
    return values.length;
  }

  async xadd(key: string, fields: Record<string, string>, maxlen?: number): Promise<string> {
    this.maybeFailCommand();
    const id = `${++this.seq}-0`;
    const entries = this.liveStream(key) ?? [];
    entries.push({ id, fields });
    if (maxlen !== undefined && entries.length > maxlen) {
      entries.splice(0, entries.length - maxlen);
    }
    this.streams.set(key, entries);
    return id;
  }

  async lrange(): Promise<string[]> {
    this.maybeFailCommand();
    return [];
  }

  scanMatch(): AsyncIterable<string> {
    const keys = Array.from(this.store.keys());
    return {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async (): Promise<IteratorResult<string>> =>
            i < keys.length ? { value: keys[i++], done: false } : { value: undefined as unknown as string, done: true },
        };
      },
    };
  }

  pipeline(): RedisDriverPipeline {
    return this.makePipeline();
  }

  multi(): RedisDriverPipeline {
    return this.makePipeline();
  }

  private makePipeline(): RedisDriverPipeline {
    const ops: Array<() => Promise<unknown>> = [];
    const pipe: RedisDriverPipeline = {
      hset: (key, mapping) => {
        ops.push(() => this.hset(key, mapping));
        return pipe;
      },
      expire: (key, seconds) => {
        ops.push(() => this.expire(key, seconds));
        return pipe;
      },
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    };
    return pipe;
  }

  async close(): Promise<void> {}
}
