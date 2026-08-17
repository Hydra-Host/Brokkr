import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { z } from 'zod';
import { rawAtomEnvelopeSchema, type AtomEnvelope, type AtomEnvelopeFailed } from './atom-envelope.types';
import { REDIS_CLIENT } from './redis.tokens';

// GET→compare→SET runs server-side so writers can't race; ARGV[2]=written_at millis, ARGV[3]=ttl seconds (<=0 = none); returns 'STALE' when the existing valid envelope is same-or-newer.
const SET_ENVELOPED_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local ok, parsed = pcall(cjson.decode, existing)
  if ok and type(parsed) == 'table' and tonumber(parsed.written_at) and tonumber(parsed.written_at) >= tonumber(ARGV[2]) then
    return 'STALE'
  end
end
if tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 'OK'
`;

export const TTL_STABLE_SECONDS = 7 * 24 * 60 * 60;

export const TTL_SAGA_EPHEMERAL_SECONDS = 60 * 60;

export const TTL_NEGATIVE_CACHE_SECONDS = 60;

/** On `written: false` a newer envelope won — callers with dependent side-effects MUST skip them. */
export type AtomWriteResult = { written: boolean; reason?: 'stale' };

@Injectable()
export class ConfigAtomWriter {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(ConfigAtomWriter.name) private readonly logger: LoggerService,
  ) {}

  async setString(zoneId: string, unprefixedKey: string, value: string, ttlSeconds: number): Promise<void> {
    const key = this.prefix(zoneId, unprefixedKey);
    try {
      if (ttlSeconds > 0) {
        await this.redis.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.redis.set(key, value);
      }
    } catch (error) {
      throw new Error(`Failed to write string (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
    const ttlLabel = ttlSeconds > 0 ? `${ttlSeconds}s` : 'none';
    this.logger.log(`Wrote string (key=${key}, bytes=${value.length}, ttl=${ttlLabel})`);
  }

  async delKey(zoneId: string, unprefixedKey: string): Promise<void> {
    const key = this.prefix(zoneId, unprefixedKey);
    try {
      await this.redis.del(key);
    } catch (error) {
      throw new Error(`Failed to delete key (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
    this.logger.log(`Deleted key (key=${key})`);
  }

  async writeStringNx(zoneId: string, unprefixedKey: string, value: string, ttlSeconds: number): Promise<boolean> {
    const key = this.prefix(zoneId, unprefixedKey);
    try {
      const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      throw new Error(`Failed to write atom NX (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
  }

  async writeAtomJson<T>(
    zoneId: string,
    unprefixedKey: string,
    value: T,
    valueSchema: z.ZodSchema<T>,
    ttlSeconds: number,
    opts: { request_id: string | null },
  ): Promise<AtomWriteResult> {
    const key = this.prefix(zoneId, unprefixedKey);
    const parsed = valueSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Refusing to write malformed atom (key=${key}): ${parsed.error.message}`);
    }
    const envelope: AtomEnvelope<T> = {
      status: 'ok',
      value: parsed.data,
      written_at: Date.now(),
      request_id: opts.request_id,
    };
    return this.setEnveloped(key, envelope, ttlSeconds);
  }

  async writeAtomString(
    zoneId: string,
    unprefixedKey: string,
    value: string,
    ttlSeconds: number,
    opts: { request_id: string | null },
  ): Promise<AtomWriteResult> {
    const key = this.prefix(zoneId, unprefixedKey);
    const envelope: AtomEnvelope<string> = {
      status: 'ok',
      value,
      written_at: Date.now(),
      request_id: opts.request_id,
    };
    return this.setEnveloped(key, envelope, ttlSeconds);
  }

  async writeAtomError(
    zoneId: string,
    unprefixedKey: string,
    reason: string,
    ttlSeconds: number,
    opts: { request_id: string | null },
  ): Promise<AtomWriteResult> {
    const key = this.prefix(zoneId, unprefixedKey);
    const envelope: AtomEnvelopeFailed = {
      status: 'failed',
      reason,
      written_at: Date.now(),
      request_id: opts.request_id,
    };
    return this.setEnveloped(key, envelope, ttlSeconds);
  }

  async readAtom<T>(zoneId: string, unprefixedKey: string, valueSchema: z.ZodSchema<T>): Promise<T | null> {
    const key = this.prefix(zoneId, unprefixedKey);
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      throw new Error(`Failed to read atom (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to parse atom JSON (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }

    const envelopeResult = rawAtomEnvelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) {
      throw new Error(`Atom envelope schema mismatch (key=${key}): ${envelopeResult.error.message}`);
    }
    const envelope = envelopeResult.data;
    if (envelope.status === 'failed') return null;

    const valueResult = valueSchema.safeParse(envelope.value);
    if (!valueResult.success) {
      throw new Error(`Atom value schema mismatch (key=${key}): ${valueResult.error.message}`);
    }
    return valueResult.data;
  }

  async writeMulti(
    zoneId: string,
    operations: Array<{ op: 'set' | 'del'; key: string; value?: string; ttl?: number }>,
  ): Promise<void> {
    if (operations.length === 0) return;
    const pipeline = this.redis.multi();
    for (const operation of operations) {
      const prefixed = this.prefix(zoneId, operation.key);
      if (operation.op === 'set') {
        if (operation.ttl && operation.ttl > 0) {
          pipeline.set(prefixed, operation.value ?? '', 'EX', operation.ttl);
        } else {
          pipeline.set(prefixed, operation.value ?? '');
        }
      } else {
        pipeline.del(prefixed);
      }
    }
    try {
      const results = await pipeline.exec();
      // null exec = discarded transaction; treating it as success would mask data loss.
      if (results === null) {
        throw new Error(`writeMulti aborted: transaction discarded`);
      }
      const failed = results.find(([err]) => err !== null);
      if (failed) {
        throw failed[0];
      }
    } catch (error) {
      throw new Error(`Failed to execute MULTI with ${operations.length} operation(s): ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
    this.logger.log(`Executed MULTI with ${operations.length} operation(s) (zone=${zoneId})`);
  }

  async readJson<T>(zoneId: string, unprefixedKey: string, valueSchema: z.ZodSchema<T>): Promise<T | null> {
    const key = this.prefix(zoneId, unprefixedKey);
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      throw new Error(`Failed to read atom (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
    if (raw === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to parse atom JSON (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
    const parsed = valueSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(`Refusing to read malformed atom (key=${key}): ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Mutator must be pure — it re-runs on EXEC-abort retry; payload is NOT envelope-wrapped (pair with `readJson`). */
  async watchAndExecMulti<T>(
    zoneId: string,
    unprefixedKey: string,
    valueSchema: z.ZodSchema<T>,
    mutator: (current: T | null) => {
      value: T;
      extraOps: Array<{ op: 'set' | 'del'; key: string; value?: string; ttl?: number }>;
    },
    ttlSeconds: number,
    options: { maxRetries?: number } = {},
  ): Promise<{ updated: true; attempts: number }> {
    const maxRetries = options.maxRetries ?? 5;
    const key = this.prefix(zoneId, unprefixedKey);
    const conn = this.redis.duplicate();
    try {
      let lastReason: string | undefined;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        await conn.watch(key);
        const raw = await conn.get(key);

        let current: T | null = null;
        if (raw !== null) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw);
          } catch (error) {
            await conn.unwatch();
            throw new Error(`Failed to parse atom JSON (key=${key}): ${getErrorMessage(error)}`, { cause: error });
          }
          const parsed = valueSchema.safeParse(decoded);
          if (!parsed.success) {
            await conn.unwatch();
            throw new Error(`Refusing to mutate malformed atom (key=${key}): ${parsed.error.message}`);
          }
          current = parsed.data;
        }

        const { value: nextValue, extraOps } = mutator(current);
        const revalidated = valueSchema.safeParse(nextValue);
        if (!revalidated.success) {
          await conn.unwatch();
          throw new Error(`Refusing to write malformed atom after mutation (key=${key}): ${revalidated.error.message}`);
        }

        const serialized = JSON.stringify(revalidated.data);
        const pipeline = conn.multi();
        for (const operation of extraOps) {
          const prefixed = this.prefix(zoneId, operation.key);
          if (operation.op === 'set') {
            if (operation.ttl && operation.ttl > 0) {
              pipeline.set(prefixed, operation.value ?? '', 'EX', operation.ttl);
            } else {
              pipeline.set(prefixed, operation.value ?? '');
            }
          } else {
            pipeline.del(prefixed);
          }
        }
        if (ttlSeconds > 0) {
          pipeline.set(key, serialized, 'EX', ttlSeconds);
        } else {
          pipeline.set(key, serialized);
        }
        const results = await pipeline.exec();
        if (results === null) {
          lastReason = 'exec aborted (concurrent write)';
          continue;
        }
        const failed = results.find(([err]) => err !== null);
        if (failed) {
          throw new Error(
            `Failed to write atoms during watchAndExecMulti (key=${key}): ${getErrorMessage(failed[0])}`,
            { cause: failed[0] },
          );
        }
        this.logger.log(
          `watchAndExecMulti succeeded (key=${key}, extraOps=${extraOps.length}, attempts=${attempt + 1})`,
        );
        return { updated: true, attempts: attempt + 1 };
      }
      throw new Error(
        `watchAndExecMulti gave up after ${maxRetries} attempt(s) (key=${key}): ${lastReason ?? 'unknown'}`,
      );
    } finally {
      try {
        await conn.quit();
      } catch {
        conn.disconnect();
      }
    }
  }

  async deleteKeys(zoneId: string, unprefixedKeys: string[]): Promise<void> {
    if (unprefixedKeys.length === 0) return;
    const prefixedKeys = unprefixedKeys.map((k) => this.prefix(zoneId, k));
    try {
      await this.redis.del(...prefixedKeys);
    } catch (error) {
      throw new Error(`Failed to delete ${prefixedKeys.length} atom(s): ${getErrorMessage(error)}`, { cause: error });
    }
    this.logger.log(`Deleted ${prefixedKeys.length} atom(s) (first=${prefixedKeys[0]})`);
  }

  /** Plain SET would be racy — a later-landing writer can carry an EARLIER `written_at`, rolling the atom back in time; STALE propagates so losing writers skip derived side-effects. */
  private async setEnveloped<T>(key: string, envelope: AtomEnvelope<T>, ttlSeconds: number): Promise<AtomWriteResult> {
    const payload = JSON.stringify(envelope);
    let result: unknown;
    try {
      result = await this.redis.eval(
        SET_ENVELOPED_LUA,
        1,
        key,
        payload,
        String(envelope.written_at),
        String(ttlSeconds),
      );
    } catch (error) {
      throw new Error(`Failed to write atom (key=${key}): ${getErrorMessage(error)}`, { cause: error });
    }
    if (result === 'STALE') {
      this.logger.debug(`Refused stale envelope write (key=${key}, our_ts=${envelope.written_at})`);
      return { written: false, reason: 'stale' };
    }
    const ttlLabel = ttlSeconds > 0 ? `${ttlSeconds}s` : 'none';
    this.logger.log(
      `Wrote atom (key=${key}, status=${envelope.status}, bytes=${payload.length}, ttl=${ttlLabel}, request_id=${envelope.request_id ?? 'null'})`,
    );
    return { written: true };
  }

  private prefix(zoneId: string, unprefixedKey: string): string {
    return `${zoneId}:${unprefixedKey}`;
  }
}
