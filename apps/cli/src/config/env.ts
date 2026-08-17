import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'brokkr');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface EnvironmentProfile {
  apiUrl: string;
  connectionMode?: 'http' | 'bridge';
  apiKey?: string;
}

interface BrokkrConfig {
  activeEnv: string;
  environments: Record<string, EnvironmentProfile>;
}

const DEFAULT_CONFIG: BrokkrConfig = {
  activeEnv: process.env.BROKKR_DEFAULT_ENV ?? 'local',
  environments: {
    local: { apiUrl: 'http://localhost:3000' },
    brokkr: { apiUrl: 'https://brokkr.hydrahost.com' },
    vm: { apiUrl: '', connectionMode: 'bridge' },
  },
};

let cached: BrokkrConfig | null = null;

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfig(): BrokkrConfig {
  if (cached) return cached;

  if (!existsSync(CONFIG_FILE)) {
    cached = DEFAULT_CONFIG;
    return cached;
  }

  try {
    cached = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as BrokkrConfig;
  } catch {
    console.error('  Warning: config file corrupted, using defaults. Run: brokkr env use <env>');
    cached = DEFAULT_CONFIG;
  }
  return cached;
}

export function saveConfig(config: BrokkrConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, encoding: 'utf-8' });
  cached = config;
}

export function initConfigIfNeeded(): BrokkrConfig {
  if (cached) return cached;
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
  }
  return getConfig();
}

function validateEnvName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid environment name: "${name}". Must be alphanumeric, hyphens, or underscores.`);
  }
  return name;
}

export function getActiveEnv(): string {
  return validateEnvName(getConfig().activeEnv);
}

export function getConnectionMode(): 'http' | 'bridge' {
  if (process.env.BROKKR_BRIDGE === '1') return 'bridge';

  const config = getConfig();
  const env = config.environments[config.activeEnv];
  return env?.connectionMode ?? 'http';
}

export function getApiUrl(): string {
  const config = getConfig();
  const env = config.environments[config.activeEnv];
  if (!env) {
    throw new Error(`Unknown environment: ${config.activeEnv}`);
  }
  return env.apiUrl;
}

export function setActiveEnv(name: string): void {
  validateEnvName(name);
  const config = getConfig();
  if (!config.environments[name]) {
    const available = Object.keys(config.environments).join(', ');
    throw new Error(`Unknown environment "${name}". Available: ${available}`);
  }
  saveConfig({ ...config, activeEnv: name });
}

export function listEnvironments(): Array<{
  name: string;
  apiUrl: string;
  connectionMode: 'http' | 'bridge';
  active: boolean;
}> {
  const config = getConfig();
  return Object.entries(config.environments).map(([name, env]) => ({
    name,
    apiUrl: env.apiUrl,
    connectionMode: env.connectionMode ?? 'http',
    active: name === config.activeEnv,
  }));
}

export function getEnvApiKey(): string | undefined {
  const config = getConfig();
  return config.environments[config.activeEnv]?.apiKey;
}

/** All BROKKR_API_KEY reads must go through this trim: `login` trims before saving, so a padded value would log in fine then fail auth in commands that prefer the raw env var. */
export function getProcessApiKey(): string | undefined {
  const v = process.env.BROKKR_API_KEY?.trim();
  return v ? v : undefined;
}

export function setEnvApiKey(apiKey: string): void {
  const config = getConfig();
  const env = config.environments[config.activeEnv];
  if (!env) return;
  env.apiKey = apiKey;
  saveConfig(config);
}

export function clearEnvApiKey(): void {
  const config = getConfig();
  const env = config.environments[config.activeEnv];
  if (!env?.apiKey) return;
  delete env.apiKey;
  saveConfig(config);
}

/** Needed by the long-running MCP server to pick up external `brokkr env use` / `brokkr login` changes. */
export function invalidateConfigCache(): void {
  cached = null;
}
