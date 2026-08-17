import { readFileSync } from 'node:fs';

interface RedisTlsOptions {
  ca?: string;
  rejectUnauthorized: boolean;
}

interface RedisEnvOptions {
  redisUrl?: string;
  redisCaCert?: string;
  nodeTlsRejectUnauthorized?: string;
}

interface RedisConnectionConfig {
  url: string;
  tls?: RedisTlsOptions;
}

export interface RedisTransportConnectionConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: RedisTlsOptions;
  maxRetriesPerRequest: null;
}

function parseRedisUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function normalizeRedisUrl(url: string): string {
  const parsedUrl = parseRedisUrl(url);
  if (!parsedUrl) return url;

  if (parsedUrl.protocol === 'https:') {
    return url.replace(/^https:/i, 'rediss:');
  }

  return url;
}

export function shouldUseRedisTls(url: string): boolean {
  const parsedUrl = parseRedisUrl(url);
  if (!parsedUrl) return false;

  return parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'rediss:';
}

function getRedisTlsOptions({
  redisUrl,
  redisCaCert,
  nodeTlsRejectUnauthorized,
}: RedisEnvOptions): RedisTlsOptions | undefined {
  if (!redisUrl || !shouldUseRedisTls(redisUrl)) return undefined;

  return {
    ...(redisCaCert ? { ca: readFileSync(redisCaCert, 'utf8') } : {}),
    rejectUnauthorized: nodeTlsRejectUnauthorized !== '0',
  };
}

export function createRedisConnectionConfig({
  redisUrl,
  redisCaCert,
  nodeTlsRejectUnauthorized,
}: RedisEnvOptions): RedisConnectionConfig | undefined {
  if (!redisUrl) return undefined;

  const url = normalizeRedisUrl(redisUrl);
  const tls = getRedisTlsOptions({
    redisUrl,
    redisCaCert,
    nodeTlsRejectUnauthorized,
  });

  return { url, ...(tls ? { tls } : {}) };
}

export function createRedisTransportConnectionConfig({
  redisUrl,
  redisCaCert,
  nodeTlsRejectUnauthorized,
}: RedisEnvOptions): RedisTransportConnectionConfig {
  const url = normalizeRedisUrl(redisUrl ?? 'redis://localhost:6379');
  const parsedUrl = new URL(url);

  const hasPassword = parsedUrl.password.length > 0;
  const tls = getRedisTlsOptions({
    redisUrl,
    redisCaCert,
    nodeTlsRejectUnauthorized,
  });
  const dbSegment = parsedUrl.pathname.replace(/^\//, '');
  const db = dbSegment ? parseInt(dbSegment, 10) : NaN;

  return {
    host: parsedUrl.hostname,
    port: Number(parsedUrl.port || 6379),
    ...(hasPassword
      ? {
          username: decodeURIComponent(parsedUrl.username) || 'default',
          password: decodeURIComponent(parsedUrl.password),
        }
      : {}),
    ...(Number.isNaN(db) ? {} : { db }),
    ...(tls ? { tls } : {}),
    maxRetriesPerRequest: null,
  };
}
