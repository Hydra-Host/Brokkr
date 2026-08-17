import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { logDebug } from '../logger/logger.service.js';

const FALLBACK_VERSION = '0.0.0-dev';

function resolveBridgeVersion(): string {
  const env = process.env.BRIDGE_API_VERSION;
  if (env) return env;
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

const BRIDGE_VERSION = resolveBridgeVersion();

export function getBridgeVersion(): string {
  return BRIDGE_VERSION;
}
