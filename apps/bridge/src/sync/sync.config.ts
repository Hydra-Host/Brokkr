import { getBrokkrEnv, isLocalSimulationEnabled } from '../redfish/redfish.config.js';

const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

function parseIntStrict(name: string, value: string): number {
  if (!STRICT_INT_PATTERN.test(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value.replace(/_/g, ''), 10);
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  return parseIntStrict(name, v);
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

export class HTTPSConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HTTPSConfigError';
  }
}

export interface SyncConfig {
  brokkrLiveVersion: string;
  httpsDownloadTimeout: number;
  httpsStallTimeout: number;
  httpsVerifySsl: boolean;
  httpsRetryAttempts: number;
  httpsRetryDelay: number;
  osLayerUrl: string;
  discoveryBaseUrl: string;
  environment: string;
  localSimulationEnabled: boolean;
}

// Anywhere else HTTPS_VERIFY_SSL=false is a supply-chain hole: the manifest's own sha256sums become attacker-controlled.
const TLS_OPTIONAL_ENVIRONMENTS: ReadonlySet<string> = new Set(['local', 'dev']);

// Defense-in-depth against command injection in the curl-over-SSH layer.
const FORBIDDEN_URL_CHARS = new Set('"\'\\`$;&|<>\n\r\t '.split(''));

export const DEFAULT_BROKKR_LIVE_VERSION = '1.1.9';

export function buildSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const environment = (getBrokkrEnv(env) || 'prod').trim().toLowerCase();
  const defaultOsLayerUrl = `https://brokkr.assets.${environment}.example.com/os-layers/blobs`;
  const defaultBrokkrLiveUrl = `https://brokkr.assets.${environment}.example.com/brokkr-live`;

  return {
    brokkrLiveVersion: envString(env, 'BROKKR_LIVE_VERSION', DEFAULT_BROKKR_LIVE_VERSION),
    httpsDownloadTimeout: envInt(env, 'HTTPS_DOWNLOAD_TIMEOUT', 3600),
    // Per-read idle budget so a mid-stream stall can't hang for the full download timeout.
    httpsStallTimeout: envInt(env, 'HTTPS_STALL_TIMEOUT', 120),
    httpsVerifySsl: envBool(env, 'HTTPS_VERIFY_SSL', true),
    httpsRetryAttempts: envInt(env, 'HTTPS_RETRY_ATTEMPTS', 3),
    httpsRetryDelay: envInt(env, 'HTTPS_RETRY_DELAY', 5),
    osLayerUrl: envString(env, 'OS_LAYER_URL', defaultOsLayerUrl),
    discoveryBaseUrl: envString(env, 'DISCOVERY_BASE_URL', defaultBrokkrLiveUrl),
    environment,
    localSimulationEnabled: isLocalSimulationEnabled(env),
  };
}

/** Rejects characters that would break shell quoting in the curl-tar SSH command. */
export function validateHttpsConfig(cfg: SyncConfig): void {
  const errors: string[] = [];

  if (!cfg.osLayerUrl) {
    errors.push('OS_LAYER_URL is not configured');
  } else if (!(cfg.osLayerUrl.startsWith('https://') || cfg.osLayerUrl.startsWith('http://'))) {
    errors.push(`OS_LAYER_URL must be an HTTP/HTTPS URL, got: ${cfg.osLayerUrl}`);
  } else {
    const bad = Array.from(new Set(Array.from(cfg.osLayerUrl).filter((ch) => FORBIDDEN_URL_CHARS.has(ch)))).sort();
    if (bad.length > 0) {
      errors.push(`OS_LAYER_URL contains shell-unsafe characters ${formatBadChars(bad)}: ${cfg.osLayerUrl}`);
    }
  }

  if (cfg.httpsDownloadTimeout <= 0) {
    errors.push(`HTTPS_DOWNLOAD_TIMEOUT must be positive, got: ${cfg.httpsDownloadTimeout}`);
  } else if (cfg.httpsDownloadTimeout < 30) {
    errors.push(
      `HTTPS_DOWNLOAD_TIMEOUT is very low (${cfg.httpsDownloadTimeout}s), may cause timeouts for large files`,
    );
  }

  if (cfg.httpsStallTimeout <= 0) {
    errors.push(`HTTPS_STALL_TIMEOUT must be positive, got: ${cfg.httpsStallTimeout}`);
  } else if (cfg.httpsStallTimeout < 10) {
    errors.push(`HTTPS_STALL_TIMEOUT is very low (${cfg.httpsStallTimeout}s), a slow link may abort mid-transfer`);
  } else if (cfg.httpsDownloadTimeout > 0 && cfg.httpsStallTimeout > cfg.httpsDownloadTimeout) {
    errors.push(
      `HTTPS_STALL_TIMEOUT (${cfg.httpsStallTimeout}s) must not exceed HTTPS_DOWNLOAD_TIMEOUT ` +
        `(${cfg.httpsDownloadTimeout}s), or the per-read idle guard has no effect`,
    );
  }

  if (cfg.httpsRetryAttempts <= 0) {
    errors.push(`HTTPS_RETRY_ATTEMPTS must be positive, got: ${cfg.httpsRetryAttempts}`);
  } else if (cfg.httpsRetryAttempts > 10) {
    errors.push(`HTTPS_RETRY_ATTEMPTS is very high (${cfg.httpsRetryAttempts}), may cause long delays on failure`);
  }

  if (cfg.httpsRetryDelay < 0) {
    errors.push(`HTTPS_RETRY_DELAY must be non-negative, got: ${cfg.httpsRetryDelay}`);
  }

  if (!cfg.httpsVerifySsl && !cfg.localSimulationEnabled && !TLS_OPTIONAL_ENVIRONMENTS.has(cfg.environment)) {
    errors.push(
      `HTTPS_VERIFY_SSL=false is only permitted when LOCAL_SIMULATION_ENABLED=true or the resolved ` +
        `environment (BROKKR_ENV ?? HH_ENV ?? ENVIRONMENT) is one of ` +
        `${Array.from(TLS_OPTIONAL_ENVIRONMENTS).join('/')}; refusing to disable TLS verification ` +
        `(environment='${cfg.environment}', localSimulation=${cfg.localSimulationEnabled})`,
    );
  }

  if (errors.length > 0) {
    throw new HTTPSConfigError('HTTPS sync configuration is invalid:\n  - ' + errors.join('\n  - '));
  }
}

/** Where TLS can be off, the manifest's integrity fields are already attacker-controlled so demanding a sha buys nothing; sim manifests legitimately omit it. */
export function allowsUnverifiedArtifacts(cfg: Pick<SyncConfig, 'environment' | 'localSimulationEnabled'>): boolean {
  return cfg.localSimulationEnabled || TLS_OPTIONAL_ENVIRONMENTS.has(cfg.environment);
}

function formatBadChars(chars: string[]): string {
  const inner = chars.map((c) => `'${escapeChar(c)}'`).join(', ');
  return `[${inner}]`;
}

function escapeChar(ch: string): string {
  switch (ch) {
    case '\\':
      return '\\\\';
    case "'":
      return "\\'";
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      return ch;
  }
}

let cached: SyncConfig | null = null;

export function getSyncConfig(): SyncConfig {
  if (cached === null) {
    cached = buildSyncConfig();
  }
  return cached;
}

export function resetSyncConfigForTests(): void {
  cached = null;
}

export function resetSyncConfig(): void {
  cached = null;
}

export interface PersistentStorageConfig {
  basePath: string;
  getPath(subpath?: string): string;
}

function buildPersistentStorageConfig(env: NodeJS.ProcessEnv = process.env): PersistentStorageConfig {
  const basePath = envString(env, 'PERSISTENT_STORAGE_PATH', '/brokkr');
  return {
    basePath,
    getPath(subpath: string = ''): string {
      if (!subpath) return basePath;
      const stripped = subpath.replace(/^\/+/, '');
      return posixPathJoin(basePath, stripped);
    },
  };
}

function posixPathJoin(base: string, sub: string): string {
  if (base === '' || base === '.') return sub;
  if (base === '/') return `/${sub}`;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${sub}`;
}

let cachedPersistentStorage: PersistentStorageConfig | null = null;

export function getPersistentStorageConfig(): PersistentStorageConfig {
  if (cachedPersistentStorage === null) {
    cachedPersistentStorage = buildPersistentStorageConfig();
  }
  return cachedPersistentStorage;
}

export function resetPersistentStorageConfig(): void {
  cachedPersistentStorage = null;
}

export interface StorageConfig {
  brokkrLiveHttpsDir: string;
  initrdBuildsDir: string;
}

function buildStorageConfig(): StorageConfig {
  const persistent = getPersistentStorageConfig();
  return {
    brokkrLiveHttpsDir: persistent.getPath('brokkr-live'),
    initrdBuildsDir: persistent.getPath('initrd-builds'),
  };
}

let cachedStorage: StorageConfig | null = null;

export function getStorageConfig(): StorageConfig {
  if (cachedStorage === null) {
    cachedStorage = buildStorageConfig();
  }
  return cachedStorage;
}

export function resetStorageConfig(): void {
  cachedStorage = null;
}
