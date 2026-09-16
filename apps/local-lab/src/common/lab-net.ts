import { Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

import type { Principal } from './lab-capability';

const log = new Logger('LabPrincipal');

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return a === '::1' || a === 'localhost' || a.startsWith('127.');
}

export function effectiveClientAddress(
  socketPeerAddr: string | undefined,
  forwardedFor: string | string[] | undefined,
): string | undefined {
  if (process.env.LAB_TRUST_PROXY !== '1') return socketPeerAddr;
  if (!isLoopbackAddress(socketPeerAddr)) return socketPeerAddr;
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (!raw) return socketPeerAddr;
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length ? entries[entries.length - 1] : socketPeerAddr;
}

function tokenMatches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Latches on the message, so a per-request check does not repeat one line every request. */
const logOnce = (() => {
  let last: string | undefined;
  return (message: string | undefined): void => {
    if (message !== undefined && message !== last) log.error(message);
    last = message;
  };
})();

/** One comparison per candidate, both evaluated before the answer is chosen. The host token is never
 *  injected into a bundle, so a surface holding only the api token cannot reach `host-exec`. */
export function resolvePrincipal(provided: string | undefined | null): Principal | null {
  if (!provided) return null;
  const apiToken = process.env.LAB_API_TOKEN;
  const hostToken = process.env.LAB_HOST_TOKEN;
  // pointing both at one value would hand host-exec to every browser holding the injected token, so a
  // collision refuses every principal instead of silently resolving the stronger one
  if (apiToken && hostToken && apiToken === hostToken) {
    logOnce('LAB_HOST_TOKEN and LAB_API_TOKEN hold the same value: refusing every token until they differ');
    return null;
  }
  logOnce(undefined);
  const host = tokenMatches(provided, hostToken);
  const api = tokenMatches(provided, apiToken);
  if (host) return { id: 'host', ceiling: 'host-exec' };
  if (api) return { id: 'api', ceiling: 'admin' };
  return null;
}

// a blank credential is an absent one, not a guess: the lab SPA sends `x-lab-token: ''` until a token is
// configured, and ts-rest strips only undefined header values
function presented(value: string | undefined | null): string | undefined {
  return value === undefined || value === null || value.trim() === '' ? undefined : value;
}

function headerToken(tokenHeader: string | string[] | undefined): string | undefined {
  if (typeof tokenHeader === 'string') return tokenHeader;
  return Array.isArray(tokenHeader) ? tokenHeader[0] : undefined;
}

export function extractToken(
  authHeader: string | undefined,
  tokenHeader: string | string[] | undefined,
  queryToken?: string | null,
): string | undefined {
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  return presented(bearer) ?? presented(headerToken(tokenHeader)) ?? presented(queryToken);
}
