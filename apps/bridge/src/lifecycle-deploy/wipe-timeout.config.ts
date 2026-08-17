const DEFAULT_STALL_TIMEOUT_S = 600;
const DEFAULT_ABSOLUTE_TIMEOUT_S = 28_800;
const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

export interface WipeTimeoutConfig {
  stallTimeoutS: number;
  absoluteTimeoutS: number;
}

function parseTimeout(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!STRICT_INT_PATTERN.test(raw)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(raw.replace(/_/g, ''), 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function buildWipeTimeoutConfig(env: NodeJS.ProcessEnv = process.env): WipeTimeoutConfig {
  const stallTimeoutS = parseTimeout(env, 'WIPE_STALL_TIMEOUT_SECONDS', DEFAULT_STALL_TIMEOUT_S);
  const absoluteTimeoutS = parseTimeout(env, 'WIPE_ABSOLUTE_TIMEOUT_SECONDS', DEFAULT_ABSOLUTE_TIMEOUT_S);

  if (stallTimeoutS <= 0) {
    throw new Error(`WIPE_STALL_TIMEOUT_SECONDS (${stallTimeoutS}) must be positive`);
  }
  if (absoluteTimeoutS <= 0) {
    throw new Error(`WIPE_ABSOLUTE_TIMEOUT_SECONDS (${absoluteTimeoutS}) must be positive`);
  }
  if (stallTimeoutS >= absoluteTimeoutS) {
    throw new Error(
      `WIPE_STALL_TIMEOUT_SECONDS (${stallTimeoutS}) must be less than ` +
        `WIPE_ABSOLUTE_TIMEOUT_SECONDS (${absoluteTimeoutS})`,
    );
  }

  return { stallTimeoutS, absoluteTimeoutS };
}

let cached: WipeTimeoutConfig | null = null;

export function getWipeTimeoutConfig(): WipeTimeoutConfig {
  if (cached === null) {
    cached = buildWipeTimeoutConfig();
  }
  return cached;
}

export function resetWipeTimeoutConfigForTests(): void {
  cached = null;
}
