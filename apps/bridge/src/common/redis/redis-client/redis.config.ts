import { sanitizeRedisUrl } from './url-sanitize';

const DEFAULT_URL = 'redis://localhost:6379/0';
const THIRTY_DAYS_S = 2_592_000;

export interface RedisCacheTtls {
  deviceNetplan: number;
  bmcCipher: number;
  deviceSshIp: number;
  resolvedIp: number;
  deviceInitrd: number;
  bridgeInterfaces: number;
  syncVersion: number;
}

export interface RedisConfig {
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
  db: number;
  tls: boolean;
  tlsCaCert: string;
  prefix: string;
  socketTimeout: number;
  socketConnectTimeout: number;
  retryOnError: boolean;
  maxConnections: number;
  encryptionKey: string;
  ttls: RedisCacheTtls;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  const trimmed = v.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer, got ${v}`);
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be an integer, got ${v}`);
  }
  return n;
}

function envFloat(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  const trimmed = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    throw new Error(`${name} must be a number, got ${v}`);
  }
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${v}`);
  }
  return n;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true';
}

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined ? fallback : v;
}

function parseDbFromPath(path: string): number {
  const trimmed = path.replace(/^\/+/, '');
  if (trimmed === '') return 0;
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`REDIS_URL path component must be an integer DB number, got '${trimmed}'`);
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n)) {
    throw new Error(`REDIS_URL path component must be an integer DB number, got '${trimmed}'`);
  }
  return n;
}

export function loadRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const raw = env.REDIS_URL ?? DEFAULT_URL;
  const url = sanitizeRedisUrl(raw);
  const parsed = new URL(url);
  const hostname = parsed.hostname || 'localhost';
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const parsedPort = parsed.port === '' ? 0 : Number.parseInt(parsed.port, 10);
  const port = parsedPort || 6379;
  const username = parsed.username;
  const password = parsed.password === '' ? '' : decodeURIComponent(parsed.password);
  const tls = parsed.protocol === 'rediss:';
  const db = parseDbFromPath(parsed.pathname);

  return {
    url,
    host,
    port,
    username,
    password,
    db,
    tls,
    tlsCaCert: envString(env, 'REDIS_CA_CERT', ''),
    // Prefix IS the zone UUID — must equal the hub's per-zone BullMQ queue prefix or the bridge consumes nothing.
    prefix: envString(env, 'BROKKR_ZONE_ID', '').trim(),
    socketTimeout: envFloat(env, 'REDIS_SOCKET_TIMEOUT', 5),
    socketConnectTimeout: envFloat(env, 'REDIS_SOCKET_CONNECT_TIMEOUT', 5),
    retryOnError: envBool(env, 'REDIS_RETRY_ON_ERROR', true),
    maxConnections: envInt(env, 'REDIS_MAX_CONNECTIONS', 50),
    encryptionKey: envString(env, 'BRIDGE_AT_REST_KEY', ''),
    ttls: {
      deviceNetplan: envInt(env, 'REDIS_TTL_DEVICE_NETPLAN', 120),
      bmcCipher: envInt(env, 'REDIS_TTL_BMC_CIPHER', THIRTY_DAYS_S),
      deviceSshIp: envInt(env, 'REDIS_TTL_DEVICE_SSH_IP', 300),
      resolvedIp: envInt(env, 'REDIS_TTL_RESOLVED_IP', 3600),
      deviceInitrd: envInt(env, 'REDIS_TTL_DEVICE_INITRD', 600),
      bridgeInterfaces: envInt(env, 'REDIS_TTL_BRIDGE_INTERFACES', 300),
      syncVersion: envInt(env, 'REDIS_TTL_SYNC_VERSION', THIRTY_DAYS_S),
    },
  };
}

export function ttlOrNone(ttl: number): number | undefined {
  return ttl > 0 ? ttl : undefined;
}
