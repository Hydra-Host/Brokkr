export interface RedisDriverPipeline {
  hset(key: string, mapping: Record<string, string>): RedisDriverPipeline;
  expire(key: string, seconds: number): RedisDriverPipeline;
  exec(): Promise<unknown[]>;
}

export interface RedisDriver {
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  setNx(key: string, value: string, ttl?: number): Promise<boolean>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  rpush(key: string, values: string[]): Promise<number>;
  xadd(key: string, fields: Record<string, string>, maxlen?: number): Promise<string>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  hset(key: string, mapping: Record<string, string>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  scanMatch(match: string, count: number): AsyncIterable<string>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  pipeline(): RedisDriverPipeline;
  multi(): RedisDriverPipeline;
  close(): Promise<void>;
}

export type RedisDriverFactory = () => Promise<RedisDriver>;
