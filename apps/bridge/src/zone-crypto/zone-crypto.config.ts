export interface ZoneCryptoConfig {
  hubUrl: string;

  registrationToken: string;

  httpTimeoutSeconds: number;

  pollInitialBackoffSeconds: number;
  pollMaxBackoffSeconds: number;
  pollTotalTimeoutSeconds: number;

  cacheKey: 'zone_crypto';

  // Sticky marker meaning "this bridge has been encrypted before": a broken cache then fails closed instead of silently regressing to plaintext (downgrade-attack mitigation).
  markerPath: string;
}

const DECIMAL_PATTERN = /^[+-]?(\d(_?\d)*\.(\d(_?\d)*)?|\.\d(_?\d)*|\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/;
const SPECIAL_FLOAT_PATTERN = /^[+-]?(inf(inity)?|nan)$/i;

function parseStrictFloat(name: string, value: string): number {
  const trimmed = value.trim();
  if (SPECIAL_FLOAT_PATTERN.test(trimmed)) {
    return Number.parseFloat(trimmed.replace(/inf(inity)?/i, 'Infinity'));
  }
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(value)}`);
  }
  return Number.parseFloat(trimmed.replace(/_/g, ''));
}

function envFloat(env: NodeJS.ProcessEnv, name: string, def: string): number {
  const raw = env[name];
  return parseStrictFloat(name, raw ?? def);
}

function envStringStripped(env: NodeJS.ProcessEnv, name: string, def: string): string {
  const raw = env[name];
  return (raw ?? def).trim();
}

export function buildZoneCryptoConfig(env: NodeJS.ProcessEnv = process.env): ZoneCryptoConfig {
  return {
    hubUrl: envStringStripped(env, 'BROKKR_HUB_URL', ''),
    registrationToken: envStringStripped(env, 'BROKKR_REGISTRATION_TOKEN', ''),
    httpTimeoutSeconds: envFloat(env, 'ZONE_CRYPTO_HTTP_TIMEOUT_SECONDS', '30'),
    pollInitialBackoffSeconds: envFloat(env, 'ZONE_CRYPTO_POLL_INITIAL_BACKOFF_SECONDS', '1'),
    pollMaxBackoffSeconds: envFloat(env, 'ZONE_CRYPTO_POLL_MAX_BACKOFF_SECONDS', '300'),
    pollTotalTimeoutSeconds: envFloat(env, 'ZONE_CRYPTO_POLL_TOTAL_TIMEOUT_SECONDS', '600'),
    cacheKey: 'zone_crypto',
    markerPath: envStringStripped(env, 'BRIDGE_ZONE_CRYPTO_MARKER_PATH', '/var/lib/brokkr-bridge/zone-crypto.lock'),
  };
}

let cached: ZoneCryptoConfig | null = null;

export function getZoneCryptoConfig(): ZoneCryptoConfig {
  if (cached === null) {
    cached = buildZoneCryptoConfig();
  }
  return cached;
}

export function resetZoneCryptoConfigForTests(): void {
  cached = null;
}
