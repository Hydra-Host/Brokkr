import { getErrorMessage } from '../common/error-utils.js';
import type { RedisClientLogger, RedisConfig } from '../common/redis/redis-client/index.js';
import { createIoredisDriverFactory } from '../common/redis/redis-client/ioredis-driver.js';
import { loadRedisConfig } from '../common/redis/redis-client/redis.config.js';
import type { RedisModuleOptions } from '../common/redis/redis.module.js';
import { getLogger, logError } from '../logger/logger.service.js';

// Sync signature required: RedisClient logs from connection-error paths that must not block on a Promise.
const redisLogger: RedisClientLogger = {
  debug: (msg, jobId) => void getLogger().debug(msg, { jobId }),
  info: (msg, jobId) => void getLogger().info(msg, { jobId }),
  warn: (msg, jobId) => void getLogger().warning(msg, { jobId }),
  error: (msg, jobId) => void getLogger().error(msg, { jobId }),
};

export class RedisEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisEncryptionConfigError';
  }
}

// Fail closed: an unset BRIDGE_AT_REST_KEY would write BMC creds/tokens/password hashes to Redis as plaintext. No env is exempt.
export function assertRedisEncryptionConfig(
  config: RedisConfig,
  _env: NodeJS.ProcessEnv = process.env,
  _logger: RedisClientLogger = redisLogger,
): void {
  if (config.encryptionKey) return;
  throw new RedisEncryptionConfigError(
    `BRIDGE_AT_REST_KEY (32-byte base64) is required; refusing to start — set it (devenv provides a local default).`,
  );
}

export function buildRedisModuleOptions(env: NodeJS.ProcessEnv = process.env): RedisModuleOptions {
  let config: RedisConfig;
  try {
    config = loadRedisConfig(env);
  } catch (error) {
    void logError(
      `REDIS_* env parse failed; falling back to redis://localhost:6379/0 (driver will surface ECONNREFUSED if not present): ${getErrorMessage(error)}`,
      { appClassName: 'app-root-providers' },
    );
    config = {
      url: 'redis://localhost:6379/0',
      host: 'localhost',
      port: 6379,
      username: '',
      password: '',
      db: 0,
      tls: false,
      tlsCaCert: '',
      prefix: '',
      socketTimeout: 5,
      socketConnectTimeout: 5,
      retryOnError: true,
      maxConnections: 50,
      // Read the key from env, not '': a hardcoded empty key would falsely fail closed (or run unencrypted) when the key is set.
      encryptionKey: env.BRIDGE_AT_REST_KEY ?? '',
      ttls: {
        deviceNetplan: 120,
        bmcCipher: 2_592_000,
        deviceSshIp: 300,
        resolvedIp: 3600,
        deviceInitrd: 600,
        bridgeInterfaces: 300,
        syncVersion: 2_592_000,
      },
    };
  }
  assertRedisEncryptionConfig(config, env, redisLogger);
  return { config, driverFactory: createIoredisDriverFactory(config, 'redis:app-root'), logger: redisLogger };
}
