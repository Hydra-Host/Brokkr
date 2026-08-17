import { join } from 'node:path';

import { resolveAssetsDir } from '../core/application.config.js';

const DEFAULT_BRIDGE_URL = 'https://brokkr.lan';
const DISCOVERY_PLATFORM_SLUG = 'brokkr-discovery';
const FINAL_BUILDS_DIR = '/opt/brokkr/ipxe-builds';

export interface IpxeConfig {
  bridgeUrl: string;
  environment: string;
  discoveryPlatformSlug: string;
  finalBuildsDir: string;
  assetsDir: string;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function buildIpxeConfig(env: NodeJS.ProcessEnv = process.env): IpxeConfig {
  const bridgeUrl = trimTrailingSlashes(env.BRIDGE_URL ?? DEFAULT_BRIDGE_URL);
  const environment = env.ENVIRONMENT ?? 'prod';
  return {
    bridgeUrl,
    environment,
    discoveryPlatformSlug: DISCOVERY_PLATFORM_SLUG,
    finalBuildsDir: FINAL_BUILDS_DIR,
    assetsDir: join(resolveAssetsDir(env), 'ipxe'),
  };
}

let cached: IpxeConfig | null = null;

export function getIpxeConfig(): IpxeConfig {
  if (cached === null) {
    cached = buildIpxeConfig();
  }
  return cached;
}

export function resetIpxeConfigForTests(): void {
  cached = null;
}
