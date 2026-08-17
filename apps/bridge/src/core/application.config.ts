import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { logDebug } from '../logger/logger.service';
import { resolveListenHost } from '../startup/listen-target';

function envInt(def: number): z.ZodTypeAny {
  return z
    .union([z.string(), z.undefined()])
    .transform((value, ctx) => {
      if (value === undefined) return def;
      if (value.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return n;
    })
    .pipe(z.number().int());
}

const envSchema = z.object({
  LOG_LEVEL: z.string().default('info'),
  LOG_FORMAT: z.string().default('json'),
  LOG_SUPPRESS_JOB_ID_PREFIXES: z.string().default('health-cron-,heartbeat-'),
  BRIDGE_API_VERSION: z.string().optional(),
  HOST: z.string().optional(),
  PORT: envInt(8080),
  BROKKR_ZONE_ID: z.string().default(''),
  BRIDGE_URL: z.string().default('https://brokkr.lan'),
  ENVIRONMENT: z.string().default('prod'),
  LOCAL_SIMULATION_ENABLED: z.string().default('false'),
  ANALYTICS_ENABLED: z.string().default('false'),
  BRIDGE_SYNC_ENABLED: z.string().default('true'),
  BRIDGE_ASSETS_DIR: z.string().optional(),
});

export interface ApplicationConfig {
  logLevel: string;
  debug: boolean;
  logFormat: string;
  logSuppressJobIdPrefixes: readonly string[];
  version: string;
  host: string;
  port: number;
  zoneId: string;
  bridgeUrl: string;
  environment: string;
  localSimulationEnabled: boolean;
  analyticsEnabled: boolean;
  bridgeSyncEnabled: boolean;
  appRoot: string;
  assetsDir: string;
}

const FALLBACK_VERSION = '0.0.0-dev';

function resolveBridgeVersion(envVersion: string | undefined): string {
  if (envVersion && envVersion.length > 0) return envVersion;
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void logDebug(`bridge version read from package.json failed: ${message}`);
  }
  return FALLBACK_VERSION;
}

function parseSuppressPrefixes(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveAppRoot(): string {
  return resolve(__dirname, '..', '..');
}

function deriveAssetsDir(override: string | undefined, appRoot: string): string {
  if (override && override.length > 0) return override;
  return resolve(appRoot, 'assets');
}

export function resolveAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return deriveAssetsDir(env.BRIDGE_ASSETS_DIR ?? env.ASSETS_DIR, resolveAppRoot());
}

export function buildApplicationConfig(env: NodeJS.ProcessEnv = process.env): ApplicationConfig {
  const parsed = envSchema.parse(env);
  const logLevel = parsed.LOG_LEVEL.toLowerCase();
  const environment = parsed.ENVIRONMENT;
  const localSimulationEnabled = parsed.LOCAL_SIMULATION_ENABLED.toLowerCase() === 'true';
  const appRoot = resolveAppRoot();
  return {
    logLevel,
    debug: logLevel === 'debug',
    logFormat: parsed.LOG_FORMAT.toLowerCase(),
    logSuppressJobIdPrefixes: parseSuppressPrefixes(parsed.LOG_SUPPRESS_JOB_ID_PREFIXES),
    version: resolveBridgeVersion(parsed.BRIDGE_API_VERSION),
    host: resolveListenHost(env),
    port: parsed.PORT,
    zoneId: parsed.BROKKR_ZONE_ID.trim(),
    bridgeUrl: parsed.BRIDGE_URL.replace(/\/+$/, ''),
    environment,
    localSimulationEnabled,
    analyticsEnabled: parsed.ANALYTICS_ENABLED.toLowerCase() === 'true',
    bridgeSyncEnabled: parsed.BRIDGE_SYNC_ENABLED.toLowerCase() === 'true',
    appRoot,
    assetsDir: resolveAssetsDir(env),
  };
}

let cached: ApplicationConfig | null = null;

export function getApplicationConfig(): ApplicationConfig {
  if (cached === null) {
    cached = buildApplicationConfig();
  }
  return cached;
}

export function resetApplicationConfigForTests(): void {
  cached = null;
}

// An empty zone id in rendered agent configs silently breaks zone-crypto enrollment and AAD routing.
export function getZoneId(): string {
  const id = getApplicationConfig().zoneId;
  if (!id) {
    throw new Error(
      "BROKKR_ZONE_ID is not set; cannot resolve zone identity. Set this to the hub's Zone.id (UUID) issued at zone creation.",
    );
  }
  return id;
}
