const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

function parseStrictInt(name: string, value: string): number {
  if (!STRICT_INT_PATTERN.test(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value.replace(/_/g, ''), 10);
}

function parseStrictFloat(name: string, value: string): number {
  const coerced = Number(value);
  if (Number.isNaN(coerced) && value.trim().toLowerCase() !== 'nan') {
    throw new Error(`${name} must be a number, got ${JSON.stringify(value)}`);
  }
  return coerced;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  return parseStrictInt(name, v);
}

function envFloat(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  return parseStrictFloat(name, v);
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true';
}

export interface MonitoringConfig {
  monitoringLogsEnabled: boolean;
  telegrafEnabled: boolean;
}

export function buildMonitoringConfig(env: NodeJS.ProcessEnv = process.env): MonitoringConfig {
  return {
    monitoringLogsEnabled: envBool(env, 'MONITORING_LOGS_ENABLED', false),
    telegrafEnabled: envBool(env, 'TELEGRAF_ENABLED', false),
  };
}

export type AllowedIpmiCommands = Readonly<Record<string, ReadonlyArray<string | null>>>;

export interface IpmiMonitoringConfig {
  allowedIpmiCommands: AllowedIpmiCommands;
  allowedSdrTypes: ReadonlyArray<string>;
  allowedDcmiOperations: ReadonlyArray<string>;
  allowedChassisPowerOps: ReadonlyArray<string>;
  csvOutputCommands: ReadonlyArray<string>;
  commandTimeoutSeconds: number;
}

const ALLOWED_IPMI_COMMANDS: AllowedIpmiCommands = Object.freeze({
  sensor: Object.freeze(['list', 'get', null] as const),
  sdr: Object.freeze(['list', 'type', 'elist', 'get', null] as const),
  sel: Object.freeze(['list', 'elist', 'get', 'clear'] as const),
  dcmi: Object.freeze(['power', 'get_mc_id_string', 'get_capability_info'] as const),
  fru: Object.freeze(['print', 'list', null] as const),
  lan: Object.freeze(['print', 'stats'] as const),
  lan6: Object.freeze(['print', 'stats'] as const),
  chassis: Object.freeze(['status', 'identify', 'power'] as const),
  mc: Object.freeze(['info', 'getenables'] as const),
  user: Object.freeze(['list'] as const),
  channel: Object.freeze(['info'] as const),
});

const ALLOWED_SDR_TYPES: ReadonlyArray<string> = Object.freeze(['temperature', 'voltage', 'fan', 'current', 'all']);

const ALLOWED_DCMI_OPERATIONS: ReadonlyArray<string> = Object.freeze(['reading', 'get', 'info']);

const ALLOWED_CHASSIS_POWER_OPS: ReadonlyArray<string> = Object.freeze([
  'status',
  'on',
  'off',
  'cycle',
  'reset',
  'soft',
]);

const CSV_OUTPUT_COMMANDS: ReadonlyArray<string> = Object.freeze(['sensor', 'user', 'dcmi', 'sdr', 'sel']);

export function buildIpmiMonitoringConfig(env: NodeJS.ProcessEnv = process.env): IpmiMonitoringConfig {
  return {
    allowedIpmiCommands: ALLOWED_IPMI_COMMANDS,
    allowedSdrTypes: ALLOWED_SDR_TYPES,
    allowedDcmiOperations: ALLOWED_DCMI_OPERATIONS,
    allowedChassisPowerOps: ALLOWED_CHASSIS_POWER_OPS,
    csvOutputCommands: CSV_OUTPUT_COMMANDS,
    commandTimeoutSeconds: envInt(env, 'IPMI_COMMAND_TIMEOUT', 30),
  };
}

export interface SnmpMonitoringConfig {
  commandTimeoutSeconds: number;
  maxWalkResults: number;
  bulkWalkMaxRepetitions: number;
  engineRecycleHours: number;
  requestTimeoutSeconds: number;
  allowedVersions: ReadonlyArray<string>;
  allowedAuthProtocols: ReadonlyArray<string>;
  allowedPrivProtocols: ReadonlyArray<string>;
  allowedSecurityLevels: ReadonlyArray<string>;
}

const SNMP_ALLOWED_VERSIONS: ReadonlyArray<string> = Object.freeze(['1', '2c', '3']);

const SNMP_ALLOWED_AUTH_PROTOCOLS: ReadonlyArray<string> = Object.freeze([
  'MD5',
  'SHA',
  'SHA224',
  'SHA256',
  'SHA384',
  'SHA512',
]);

const SNMP_ALLOWED_PRIV_PROTOCOLS: ReadonlyArray<string> = Object.freeze(['DES', 'AES128', 'AES256']);

const SNMP_ALLOWED_SECURITY_LEVELS: ReadonlyArray<string> = Object.freeze(['noAuthNoPriv', 'authNoPriv', 'authPriv']);

export function buildSnmpMonitoringConfig(env: NodeJS.ProcessEnv = process.env): SnmpMonitoringConfig {
  return {
    commandTimeoutSeconds: envInt(env, 'SNMP_COMMAND_TIMEOUT', 10),
    maxWalkResults: envInt(env, 'SNMP_MAX_WALK_RESULTS', 1000),
    bulkWalkMaxRepetitions: envInt(env, 'SNMP_BULK_WALK_MAX_REPS', 25),
    engineRecycleHours: envFloat(env, 'SNMP_ENGINE_RECYCLE_HOURS', 4),
    requestTimeoutSeconds: envInt(env, 'SNMP_REQUEST_TIMEOUT', 120),
    allowedVersions: SNMP_ALLOWED_VERSIONS,
    allowedAuthProtocols: SNMP_ALLOWED_AUTH_PROTOCOLS,
    allowedPrivProtocols: SNMP_ALLOWED_PRIV_PROTOCOLS,
    allowedSecurityLevels: SNMP_ALLOWED_SECURITY_LEVELS,
  };
}

let _monitoringConfig: MonitoringConfig | null = null;
let _ipmiMonitoringConfig: IpmiMonitoringConfig | null = null;
let _snmpMonitoringConfig: SnmpMonitoringConfig | null = null;

export function getMonitoringConfig(): MonitoringConfig {
  if (_monitoringConfig === null) {
    _monitoringConfig = buildMonitoringConfig();
  }
  return _monitoringConfig;
}

export function getIpmiMonitoringConfig(): IpmiMonitoringConfig {
  if (_ipmiMonitoringConfig === null) {
    _ipmiMonitoringConfig = buildIpmiMonitoringConfig();
  }
  return _ipmiMonitoringConfig;
}

export function getSnmpMonitoringConfig(): SnmpMonitoringConfig {
  if (_snmpMonitoringConfig === null) {
    _snmpMonitoringConfig = buildSnmpMonitoringConfig();
  }
  return _snmpMonitoringConfig;
}

export function resetMonitoringConfigForTests(): void {
  _monitoringConfig = null;
  _ipmiMonitoringConfig = null;
  _snmpMonitoringConfig = null;
}
