// TRUST_PROXY must only be set behind an edge proxy with the real hop count — trusting forwarded IP headers on an exposed deployment lets clients spoof per-IP rate limits.
import proxyaddr from 'proxy-addr';
import { getErrorMessage } from './error-utils';

export interface TrustProxyConfig {
  setting: boolean | number | string;
}

export class InvalidTrustProxyError extends Error {
  constructor(raw: string, cause: unknown) {
    super(
      `Invalid TRUST_PROXY value ${JSON.stringify(raw)}: expected "true"/"false", a positive ` +
        `integer hop count, or a comma-separated list of IP/CIDR addresses or presets ` +
        `(loopback, linklocal, uniquelocal). ${getErrorMessage(cause)}`,
      { cause },
    );
    this.name = 'InvalidTrustProxyError';
  }
}

function assertCompiles(raw: string, setting: string): void {
  try {
    proxyaddr.compile(setting.split(',').map((v) => v.trim()));
  } catch (cause) {
    throw new InvalidTrustProxyError(raw, cause);
  }
}

export function resolveTrustProxyConfig(env: NodeJS.ProcessEnv = process.env): TrustProxyConfig {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw || raw === 'false' || raw === '0') return { setting: false };
  if (raw === 'true' || raw === '1') return { setting: true };
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return { setting: hops };
  assertCompiles(raw, raw);
  return { setting: raw };
}
