import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';

import type { RequestOrigin } from '../contract';
import type { PrincipalId } from './lab-capability';
import { effectiveClientAddress, extractToken, isLoopbackAddress, resolvePrincipal } from './lab-net';

export interface LabOrigin {
  ip: string | null;
  loopback: boolean;
  /** a valid token was presented — not that the token authorized the request: the guard grants on
   *  loopback too, so "authorized by token" would read `!loopback && tokenAuth`. */
  tokenAuth: boolean;
  /** which token, so an audit row separates the injected api token from the host token. */
  principal: PrincipalId | null;
  method: string;
  path: string;
}

/** The request surface the origin is derived from, structural so callers need no express instance. */
export interface OriginRequest {
  ip?: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  socket: { remoteAddress?: string };
  headers: IncomingHttpHeaders;
}

const originStore = new AsyncLocalStorage<LabOrigin>();

/** `undefined` outside a request — boot-time and hook-driven work has no origin to record. */
export function currentOrigin(): LabOrigin | undefined {
  return originStore.getStore();
}

/** The three origin columns every origin-bearing table carries, `runs` and `audit_events` alike. */
export interface OriginColumns {
  origin_ip: string | null;
  origin_loopback: number | null;
  origin_token: number | null;
}

/** `audit_events` carries a fourth column `runs` does not, so the two shapes stay separate. */
export interface AuditOriginColumns extends OriginColumns {
  origin_principal: PrincipalId | null;
}

export function originColumns(origin: LabOrigin | undefined): OriginColumns {
  return {
    origin_ip: origin?.ip ?? null,
    origin_loopback: origin === undefined ? null : Number(origin.loopback),
    origin_token: origin === undefined ? null : Number(origin.tokenAuth),
  };
}

export function auditOriginColumns(origin: LabOrigin | undefined): AuditOriginColumns {
  return { ...originColumns(origin), origin_principal: origin?.principal ?? null };
}

// null across all three columns is the system-run sentinel; a written row always has all three
export function originFromColumns(row: OriginColumns): RequestOrigin | null {
  if (row.origin_ip === null && row.origin_loopback === null && row.origin_token === null) return null;
  return { ip: row.origin_ip, loopback: row.origin_loopback === 1, tokenAuth: row.origin_token === 1 };
}

export function labOriginMiddleware(req: OriginRequest, _res: unknown, next: () => void): void {
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const peer = req.ip ?? req.socket.remoteAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  const address = effectiveClientAddress(peer, forwardedFor);
  const principal = resolvePrincipal(extractToken(req.headers.authorization, req.headers['x-lab-token'], queryToken));
  originStore.run(
    {
      ip: address ?? null,
      loopback: isLoopbackAddress(address),
      tokenAuth: principal !== null,
      principal: principal?.id ?? null,
      method: req.method,
      // never originalUrl/query: the web app appends ?token=<secret> to every stream url it opens
      path: req.path,
    },
    next,
  );
}
