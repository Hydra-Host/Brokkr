import { ttlOrNone as canonicalTtlOrNone, loadRedisConfig } from '../../common/redis/redis-client/redis.config';

export interface IpmiConfig {
  commandTimeout: number;
  cipherDetectionList: (string | number | null)[];
  cipherCacheDir: string;
  ttlBmcCipher: number;
}

const INT_RE = /^[+-]?\d(_?\d)*$/;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  const trimmed = v.trim();
  if (!INT_RE.test(trimmed)) {
    throw new Error(`${name} must be an integer, got ${v}`);
  }
  const n = Number.parseInt(trimmed.replace(/_/g, ''), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be an integer, got ${v}`);
  }
  return n;
}

export function buildIpmiConfig(env: NodeJS.ProcessEnv = process.env): IpmiConfig {
  return {
    commandTimeout: envInt(env, 'IPMI_COMMAND_TIMEOUT', 30),
    cipherDetectionList: [null, 3, 17],
    cipherCacheDir: '/ipmi_ciphers',
    ttlBmcCipher: loadRedisConfig().ttls.bmcCipher,
  };
}

let _ipmiConfig: IpmiConfig | null = null;

export function getIpmiConfig(): IpmiConfig {
  if (_ipmiConfig === null) _ipmiConfig = buildIpmiConfig();
  return _ipmiConfig;
}

export const ttlOrNone = canonicalTtlOrNone;

export interface IpmiMonitoringConfig {
  allowedIpmiCommands: Record<string, (string | null)[]>;
  allowedSdrTypes: string[];
  allowedDcmiOperations: string[];
  allowedChassisPowerOps: string[];
  csvOutputCommands: string[];
  commandTimeoutSeconds: number;
}

let _ipmiMonitoringConfig: IpmiMonitoringConfig | null = null;

export function getIpmiMonitoringConfig(): IpmiMonitoringConfig {
  if (_ipmiMonitoringConfig !== null) return _ipmiMonitoringConfig;
  _ipmiMonitoringConfig = {
    allowedIpmiCommands: {
      sensor: ['list', 'get', null],
      sdr: ['list', 'type', 'elist', 'get', null],
      sel: ['list', 'elist', 'get', 'clear'],
      dcmi: ['power', 'get_mc_id_string', 'get_capability_info'],
      fru: ['print', 'list', null],
      lan: ['print', 'stats'],
      lan6: ['print', 'stats'],
      chassis: ['status', 'identify', 'power'],
      mc: ['info', 'getenables'],
      user: ['list'],
      channel: ['info'],
    },
    allowedSdrTypes: ['temperature', 'voltage', 'fan', 'current', 'all'],
    allowedDcmiOperations: ['reading', 'get', 'info'],
    allowedChassisPowerOps: ['status', 'on', 'off', 'cycle', 'reset', 'soft'],
    csvOutputCommands: ['sensor', 'user', 'dcmi', 'sdr', 'sel'],
    commandTimeoutSeconds: getIpmiConfig().commandTimeout,
  };
  return _ipmiMonitoringConfig;
}
