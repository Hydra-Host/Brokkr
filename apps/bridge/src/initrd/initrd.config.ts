import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

const envInt = (def: number) =>
  z
    .union([z.string(), z.undefined()])
    .transform((value, ctx) => {
      if (value === undefined || value === '') return def;
      const n = Number.parseInt(value.trim(), 10);
      if (Number.isNaN(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return n;
    })
    .pipe(z.number().int());

const envIntOptional = () =>
  z
    .union([z.string(), z.undefined()])
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return undefined;
      const n = Number.parseInt(value.trim(), 10);
      if (Number.isNaN(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return n;
    })
    .pipe(z.number().int().optional());

const envSchema = z.object({
  PERSISTENT_STORAGE_PATH: z.string().default('/brokkr'),
  BRIDGE_URL: z.string().default('https://brokkr.lan'),
  LOG_LEVEL: z.string().default('info'),
  ENVIRONMENT: z.string().default('prod'),
  LOCAL_SIMULATION_ENABLED: z.string().default('false'),
  BRIDGE_API_VERSION: z.string().default('0.0.0-dev'),
  BRIDGE_ASSETS_DIR: z.string().optional(),
  BROKKR_ZONE_ID: z.string().default(''),
  GRPC_EXTERNAL_PORT: envIntOptional(),
  GRPC_INTERNAL_PORT: envInt(9082),
  GRPC_INSECURE: z.string().default('false'),
  BRIDGE_GRPC_DIALBACK_HOST: z.string().default(''),
});

export interface InitrdConfig {
  initrdBuildsDir: string;
  bridgeUrl: string;
  logLevel: string;
  environment: string;
  localSimulationEnabled: boolean;
  assetsDir: string;
  apiVersion: string;
  zoneId: string;
  grpcExternalPort: number;
  grpcInsecure: boolean;
  grpcDialbackHost: string;
}

function rstripSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

function deriveAssetsDir(override: string | undefined): string {
  if (override) return override;
  return resolve(__dirname, '..', '..', 'assets');
}

export function buildInitrdConfig(env: NodeJS.ProcessEnv = process.env): InitrdConfig {
  const parsed = envSchema.parse(env);
  const environment = parsed.ENVIRONMENT;
  const simEnabled = parsed.LOCAL_SIMULATION_ENABLED.toLowerCase() === 'true';
  const grpcInsecure = parsed.GRPC_INSECURE.toLowerCase() === 'true';
  // No TLS front in insecure/sim mode, so the agent dials the internal listener directly; 443 assumes an nginx TLS front.
  const grpcExternalPort = parsed.GRPC_EXTERNAL_PORT ?? (grpcInsecure || simEnabled ? parsed.GRPC_INTERNAL_PORT : 443);
  return {
    initrdBuildsDir: join(parsed.PERSISTENT_STORAGE_PATH, 'initrd-builds'),
    bridgeUrl: rstripSlashes(parsed.BRIDGE_URL),
    logLevel: parsed.LOG_LEVEL.toLowerCase(),
    environment,
    localSimulationEnabled: simEnabled,
    assetsDir: deriveAssetsDir(parsed.BRIDGE_ASSETS_DIR),
    apiVersion: parsed.BRIDGE_API_VERSION,
    zoneId: parsed.BROKKR_ZONE_ID.trim(),
    grpcExternalPort,
    grpcInsecure,
    grpcDialbackHost: parsed.BRIDGE_GRPC_DIALBACK_HOST.trim(),
  };
}

let cached: InitrdConfig | null = null;

export function getInitrdConfig(): InitrdConfig {
  if (cached === null) {
    cached = buildInitrdConfig();
  }
  return cached;
}

export function resetInitrdConfigForTests(): void {
  cached = null;
}

// An empty zone id would silently break zone-crypto enrollment and AAD routing.
export function getZoneId(): string {
  const id = getInitrdConfig().zoneId;
  if (!id) {
    throw new Error(
      "BROKKR_ZONE_ID is not set; cannot resolve zone identity. Set this to the hub's Zone.id (UUID) issued at zone creation.",
    );
  }
  return id;
}

export async function loadBridgeSshPublicKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const priv = (env.SSH_KEY_PATH ?? env.BRIDGE_SSH_PRIVKEY_PATH ?? '').trim();
  if (!priv) return '';
  try {
    return (await readFile(`${priv}.pub`, 'utf8')).trim();
  } catch {
    return '';
  }
}
