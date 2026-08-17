import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../../error-utils';

import { z } from 'zod';

import type { RedisDriver, RedisDriverFactory } from './redis-driver';
import { RedisEncryptor } from './redis-encryptor';
import type { RedisConfig } from './redis.config';
import { RedisConnectionError, RedisOperationError } from './redis.errors';

export type RedisClientLogger = {
  debug: (message: string, jobId?: string) => void;
  info: (message: string, jobId?: string) => void;
  warn: (message: string, jobId?: string) => void;
  error: (message: string, jobId?: string) => void;
};

const SILENT_LOGGER: RedisClientLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'RedisConnectionError') return true;
  if (error.name === 'ConnectionError') return true;
  // ioredis timeout/down-connection failures don't match the names above; without these the reconnect path never runs.
  if (error.name === 'MaxRetriesPerRequestError') return true;
  if (error.message === 'Command timed out') return true;
  const code = (error as { code?: string }).code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
}

function isRedisError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isConnectionError(error)) return true;
  return error.name.startsWith('Redis');
}

const RENEW_LUA =
  'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end';
const DELETE_LUA = 'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';
const CLAIM_LUA =
  'if redis.call("set",KEYS[1],ARGV[1],"NX","EX",ARGV[2]) then return 1 ' +
  'elseif redis.call("get",KEYS[1])==ARGV[1] then return 1 else return 0 end';

const lockInfoSchema = z.object({ token: z.string() }).catchall(z.string());

export type LockHolderInfo = Readonly<Record<string, string>>;
export type LockInfo = z.infer<typeof lockInfoSchema>;

export class RedisClient {
  private readonly config: RedisConfig;
  private readonly driverFactory: RedisDriverFactory;
  private readonly encryptor: RedisEncryptor;
  private readonly logger: RedisClientLogger;
  private driver: RedisDriver | null = null;
  // Single-flight: concurrent callers share one connect so a second connection is never orphaned.
  private inflightConnect: Promise<RedisDriver> | null = null;
  private inflightReconnect: Promise<RedisDriver> | null = null;

  constructor(config: RedisConfig, driverFactory: RedisDriverFactory, logger: RedisClientLogger = SILENT_LOGGER) {
    this.config = config;
    this.driverFactory = driverFactory;
    this.logger = logger;
    this.encryptor = new RedisEncryptor(config.encryptionKey);
  }

  private key(key: string): string {
    return this.config.prefix ? `${this.config.prefix}:${key}` : key;
  }

  private async connect(jobId?: string): Promise<RedisDriver> {
    const driver = await this.driverFactory();
    try {
      await driver.ping();
    } catch (error) {
      try {
        await driver.close();
      } catch (closeError) {
        this.logger.debug(`Redis driver close failed after failed ping: ${getErrorMessage(closeError)}`, jobId);
      }
      throw error;
    }
    const caInfo = this.config.tlsCaCert ? `, ca_cert=${this.config.tlsCaCert}` : '';
    this.logger.info(
      `Redis connected to ${this.config.host}:${this.config.port} (tls=${this.config.tls}${caInfo})`,
      jobId,
    );
    return driver;
  }

  private async getDriver(jobId?: string): Promise<RedisDriver> {
    if (this.driver !== null) return this.driver;
    if (this.inflightConnect === null) {
      this.inflightConnect = this.connect(jobId).then(
        (d) => {
          this.driver = d;
          this.inflightConnect = null;
          return d;
        },
        (error) => {
          this.inflightConnect = null;
          throw error;
        },
      );
    }
    return this.inflightConnect;
  }

  private async reconnect(failed: RedisDriver | null, jobId?: string): Promise<RedisDriver> {
    if (this.inflightReconnect !== null) {
      return this.inflightReconnect;
    }
    if (this.driver !== null && this.driver !== failed) {
      return this.driver;
    }
    this.inflightReconnect = (async () => {
      try {
        await this.closeUnlocked();
        return await this.getDriver(jobId);
      } finally {
        this.inflightReconnect = null;
      }
    })();
    return this.inflightReconnect;
  }

  private async execute<T>(
    operation: string,
    func: (driver: RedisDriver) => Promise<T>,
    jobId?: string,
    opts?: { retry?: boolean },
  ): Promise<T> {
    const retry = opts?.retry ?? true;
    let driver: RedisDriver | null = null;
    try {
      driver = await this.getDriver(jobId);
      return await func(driver);
    } catch (error) {
      if (isConnectionError(error)) {
        this.logger.warn(`Redis connection error during ${operation}: ${getErrorMessage(error)}, reconnecting`, jobId);
        // Non-idempotent ops must not be replayed; heal the connection but surface the indeterminate outcome loudly.
        if (!retry) {
          try {
            await this.reconnect(driver, jobId);
          } catch (reconnectError) {
            this.logger.debug(`Redis reconnect failed during ${operation}: ${getErrorMessage(reconnectError)}`, jobId);
          }
          throw new RedisOperationError(
            `Redis ${operation} connection lost before reply; not retried (outcome indeterminate)`,
          );
        }
        try {
          driver = await this.reconnect(driver, jobId);
          return await func(driver);
        } catch (retryError) {
          if (!isRedisError(retryError)) throw retryError;
          throw new RedisOperationError(`Redis ${operation} failed after reconnect: ${getErrorMessage(retryError)}`);
        }
      }
      if (!isRedisError(error)) throw error;
      throw new RedisOperationError(`Redis ${operation} failed: ${getErrorMessage(error)}`);
    }
  }

  async requireConnection(maxAttempts = 5, backoff = 3.0): Promise<void> {
    if (this.driver !== null) return;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.getDriver('startup');
        return;
      } catch (error) {
        this.logger.warn(`Redis startup check failed (attempt ${attempt}/${maxAttempts}): ${getErrorMessage(error)}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, backoff * attempt * 1000));
        }
      }
    }
    this.logger.error(`Redis is not reachable after ${maxAttempts} attempts`);
    throw new RedisConnectionError(`Redis is not reachable after ${maxAttempts} attempts`);
  }

  async get(key: string, jobId?: string): Promise<string | null> {
    const prefixed = this.key(key);
    return this.execute('GET', (d) => d.get(prefixed), jobId);
  }

  async set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown> {
    const prefixed = this.key(key);
    if (ttl) {
      return this.execute('SET', (d) => d.setex(prefixed, ttl, value), jobId);
    }
    return this.execute('SET', (d) => d.set(prefixed, value), jobId);
  }

  async delete(key: string, jobId?: string): Promise<number> {
    const prefixed = this.key(key);
    return this.execute('DELETE', (d) => d.del(prefixed), jobId);
  }

  async exists(key: string, jobId?: string): Promise<boolean> {
    const prefixed = this.key(key);
    return Boolean(await this.execute('EXISTS', (d) => d.exists(prefixed), jobId));
  }

  async rpush(key: string, values: string[], jobId?: string): Promise<number> {
    const prefixed = this.key(key);
    return this.execute('RPUSH', (d) => d.rpush(prefixed, values), jobId);
  }

  async lrange(key: string, start: number, stop: number, jobId?: string): Promise<string[]> {
    const prefixed = this.key(key);
    return this.execute('LRANGE', (d) => d.lrange(prefixed, start, stop), jobId);
  }

  async expire(key: string, seconds: number, jobId?: string): Promise<boolean> {
    const prefixed = this.key(key);
    return Boolean(await this.execute('EXPIRE', (d) => d.expire(prefixed, seconds), jobId));
  }

  async hset(key: string, mapping: Record<string, string>, ttl?: number, jobId?: string): Promise<number> {
    const prefixed = this.key(key);
    if (ttl) {
      return this.execute(
        'HSET',
        async (d) => {
          const pipe = d.multi();
          pipe.hset(prefixed, mapping);
          pipe.expire(prefixed, ttl);
          const results = await pipe.exec();
          return results[0] as number;
        },
        jobId,
      );
    }
    return this.execute('HSET', (d) => d.hset(prefixed, mapping), jobId);
  }

  async hget(key: string, field: string, jobId?: string): Promise<string | null> {
    const prefixed = this.key(key);
    return this.execute('HGET', (d) => d.hget(prefixed, field), jobId);
  }

  async hgetall(key: string, jobId?: string): Promise<Record<string, string>> {
    const prefixed = this.key(key);
    return this.execute('HGETALL', (d) => d.hgetall(prefixed), jobId);
  }

  private encryptValue(value: string): string {
    return this.encryptor.encrypt(value);
  }

  private decryptValue(value: string): string {
    return this.encryptor.decrypt(value);
  }

  async secretSet(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown> {
    return this.set(key, this.encryptValue(value), ttl, jobId);
  }

  async secretGet(key: string, jobId?: string): Promise<string | null> {
    const value = await this.get(key, jobId);
    if (value === null) return null;
    return this.decryptValue(value);
  }

  async secretHset(key: string, mapping: Record<string, string>, ttl?: number, jobId?: string): Promise<number> {
    const encrypted: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) {
      encrypted[k] = this.encryptValue(v);
    }
    return this.hset(key, encrypted, ttl, jobId);
  }

  async secretHget(key: string, field: string, jobId?: string): Promise<string | null> {
    const value = await this.hget(key, field, jobId);
    if (value === null) return null;
    return this.decryptValue(value);
  }

  async scan(pattern: string, jobId?: string): Promise<string[]> {
    const prefixed = this.key(pattern);
    const prefixLen = this.config.prefix ? this.config.prefix.length + 1 : 0;
    return this.execute(
      'SCAN',
      async (d) => {
        const out: string[] = [];
        for await (const k of d.scanMatch(prefixed, 100)) {
          out.push(prefixLen ? k.slice(prefixLen) : k);
        }
        return out;
      },
      jobId,
    );
  }

  async setNx(key: string, value: string, ttl?: number, jobId?: string): Promise<boolean> {
    const prefixed = this.key(key);
    return this.execute('SET_NX', (d) => d.setNx(prefixed, value, ttl), jobId, { retry: false });
  }

  async setNxOwned(key: string, value: string, ttl: number, jobId?: string): Promise<boolean> {
    const prefixed = this.key(key);
    return this.execute(
      'SET_NX_OWNED',
      async (d) => {
        const result = await d.eval(CLAIM_LUA, [prefixed], [value, String(ttl)]);
        return result === 1;
      },
      jobId,
    );
  }

  async renewIfOwner(key: string, expectedValue: string, ttl: number, jobId?: string): Promise<boolean> {
    const prefixed = this.key(key);
    return this.execute(
      'RENEW_IF_OWNER',
      async (d) => {
        const result = await d.eval(RENEW_LUA, [prefixed], [expectedValue, String(ttl)]);
        return result === 1;
      },
      jobId,
    );
  }

  async renewLockIfOwner(lockKey: string, expectedValue: string, ttl: number, jobId?: string): Promise<boolean> {
    return this.renewIfOwner(`lock:${lockKey}`, expectedValue, ttl, jobId);
  }

  async deleteIfOwner(key: string, expectedValue: string, jobId?: string): Promise<boolean> {
    const prefixed = this.key(key);
    return this.execute(
      'DELETE_IF_OWNER',
      async (d) => {
        const result = await d.eval(DELETE_LUA, [prefixed], [expectedValue]);
        return result === 1;
      },
      jobId,
    );
  }

  async acquireLock(
    lockKey: string,
    timeout = 300,
    jobId?: string,
    holderInfo?: LockHolderInfo,
  ): Promise<string | null> {
    const token = randomUUID();
    const value =
      holderInfo !== undefined && Object.keys(holderInfo).length > 0 ? JSON.stringify({ ...holderInfo, token }) : token;
    const acquired = await this.setNxOwned(`lock:${lockKey}`, value, timeout, jobId);
    if (acquired) {
      this.logger.info(`Acquired lock: ${lockKey} (timeout=${timeout}s)`, jobId);
      return value;
    }
    this.logger.debug(`Lock already held: ${lockKey}`, jobId);
    return null;
  }

  async releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean> {
    const prefixed = this.key(`lock:${lockKey}`);
    const released = await this.execute(
      'RELEASE_LOCK',
      async (d) => {
        const result = await d.eval(DELETE_LUA, [prefixed], [token]);
        return result === 1;
      },
      jobId,
    );
    if (released) {
      this.logger.info(`Released lock: ${lockKey}`, jobId);
    }
    return released;
  }

  async readLockInfo(lockKey: string, jobId?: string): Promise<LockInfo | null> {
    const value = await this.get(`lock:${lockKey}`, jobId);
    if (value === null) return null;

    try {
      const parsed: unknown = JSON.parse(value);
      const result = lockInfoSchema.safeParse(parsed);
      if (result.success) return result.data;
      this.logger.debug(`Lock value for ${lockKey} is JSON but missing a valid token, treating as bare token`, jobId);
    } catch {
      this.logger.debug(`Lock value for ${lockKey} is not JSON, treating as bare token`, jobId);
    }
    return { token: value };
  }

  async waitForLockRelease(lockKey: string, timeout = 300, pollInterval = 2.0, jobId?: string): Promise<boolean> {
    const prefixed = this.key(`lock:${lockKey}`);
    const deadline = Date.now() + timeout * 1000;
    const pollMs = pollInterval * 1000;
    this.logger.info(`Waiting for lock release: ${lockKey} (timeout=${timeout}s)`, jobId);
    while (Date.now() < deadline) {
      try {
        const exists = await this.execute('EXISTS', (d) => d.exists(prefixed), jobId);
        if (!exists) {
          this.logger.info(`Lock released: ${lockKey}`, jobId);
          return true;
        }
      } catch (error) {
        this.logger.debug(`Lock release poll failed for ${lockKey}: ${getErrorMessage(error)}`, jobId);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.logger.warn(`Timed out waiting for lock release: ${lockKey}`, jobId);
    return false;
  }

  async ping(jobId?: string): Promise<boolean> {
    try {
      await this.execute('PING', (d) => d.ping(), jobId);
      return true;
    } catch (error) {
      if (error instanceof RedisOperationError || error instanceof RedisConnectionError) {
        return false;
      }
      throw error;
    }
  }

  private async closeUnlocked(): Promise<void> {
    if (this.driver) {
      try {
        await this.driver.close();
      } catch (error) {
        this.logger.debug(`Redis driver close failed: ${getErrorMessage(error)}`);
      }
      this.driver = null;
    }
  }

  async close(jobId?: string): Promise<void> {
    if (this.inflightReconnect !== null) {
      try {
        await this.inflightReconnect;
      } catch (error) {
        this.logger.debug(`Redis inflight reconnect failed during close: ${getErrorMessage(error)}`, jobId);
      }
    }
    if (this.inflightConnect !== null) {
      try {
        await this.inflightConnect;
      } catch (error) {
        this.logger.debug(`Redis inflight connect failed during close: ${getErrorMessage(error)}`, jobId);
      }
    }
    await this.closeUnlocked();
    this.logger.info('Redis connection closed', jobId);
  }
}
