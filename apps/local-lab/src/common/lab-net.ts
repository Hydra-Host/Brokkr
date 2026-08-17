import { timingSafeEqual } from 'node:crypto';

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

export function tokenMatches(provided: string | undefined | null): boolean {
  const expected = process.env.LAB_API_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractToken(
  authHeader: string | undefined,
  tokenHeader: string | string[] | undefined,
  queryToken?: string | null,
): string | undefined {
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice('Bearer '.length);
  if (typeof tokenHeader === 'string') return tokenHeader;
  if (Array.isArray(tokenHeader)) return tokenHeader[0];
  return queryToken ?? undefined;
}

export function isConnectionAuthorized(
  remoteAddr: string | undefined,
  providedToken: string | undefined,
  forwardedFor: string | string[] | undefined,
): boolean {
  const addr = effectiveClientAddress(remoteAddr, forwardedFor);
  if (isLoopbackAddress(addr)) return true;
  return tokenMatches(providedToken);
}
