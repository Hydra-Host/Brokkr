import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AuditStore } from '../ledger/audit-store';
import { PORTS } from '../ports';
import { type AuditRequest, auditParams, isSafeMethod } from './audit-row';
import { getErrorMessage } from './errors';
import { currentOrigin, originColumns } from './lab-context';
import { assertExposure } from './lab-exposure';
import { extractToken, isConnectionAuthorized, isLoopbackAddress } from './lab-net';
import { LAB_ROUTE, type LabRouteOptions } from './lab-route';

export function labBindHost(): string {
  return process.env.LAB_BIND_HOST ?? '127.0.0.1';
}

function labWebPort(): string {
  return process.env.LAB_WEB_PORT || process.env.PORT || String(PORTS.labWeb);
}

/** Explicit allowlist — never reflect arbitrary Origins. */
export function labCorsOrigins(): string[] {
  const fromEnv = process.env.LAB_CORS_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv?.length) return fromEnv;
  const webPort = labWebPort();
  return [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

// trusted: the allowlist, a loopback origin on a lab port (dev / vite proxy), or an origin naming the address
// this connection arrived on (LAN). The Host header is caller-supplied (dns rebinding) — never consulted.
export function isMutationOriginAllowed(origin: string, localAddress: string | undefined): boolean {
  if (labCorsOrigins().includes(origin)) return true;
  const source = parseUrl(origin);
  if (!source || ![labWebPort(), String(PORTS.lab)].includes(source.port)) return false;
  // new URL keeps the brackets on an ipv6 hostname
  const hostname = source.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isLoopbackAddress(hostname)) return true;
  return localAddress !== undefined && hostname === localAddress;
}

function queryTokenOf(req: Request): string | undefined {
  const t = req.query?.token;
  return typeof t === 'string' ? t : undefined;
}

/** Audits its own denials: guards run before interceptors, so a rejected request is invisible to the
 *  audit interceptor and would otherwise leave no trace of who tried what. */
@Injectable()
export class LabAuthGuard implements CanActivate {
  private readonly log = new Logger(LabAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditStore,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = extractToken(req.headers.authorization, req.headers['x-lab-token'], queryTokenOf(req));
    const peer = req.ip ?? req.socket.remoteAddress;
    const forwardedFor = req.headers['x-forwarded-for'];
    if (!isConnectionAuthorized(peer, provided, forwardedFor)) {
      const denial = new UnauthorizedException(
        'lab control API requires a valid LAB_API_TOKEN for non-loopback requests',
      );
      this.recordDenial(ctx, req, denial);
      throw denial;
    }
    const route = this.reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, ctx.getHandler());
    try {
      assertExposure(route?.exposure ?? 'token-ok', peer, forwardedFor);
    } catch (error) {
      this.recordDenial(ctx, req, error);
      throw error;
    }
    return true;
  }

  /** No duration: no handler ran, and a faked 0 would read as an instant success. */
  private recordDenial(ctx: ExecutionContext, req: AuditRequest, denial: unknown): void {
    // a denied probe of a loopback-only route must not be able to fill the capped table either
    if (isSafeMethod(req.method)) return;
    try {
      this.audit.insert({
        ts: Date.now(),
        method: req.method,
        path: req.path,
        handler: `${ctx.getClass().name}.${ctx.getHandler().name}`,
        outcome: 'denied',
        status_code: denial instanceof HttpException ? denial.getStatus() : null,
        duration_ms: null,
        run_id: null,
        params: auditParams(req),
        ...originColumns(currentOrigin()),
        error: getErrorMessage(denial),
      });
    } catch (error) {
      this.log.warn(`denial audit write failed for ${req.method} ${req.path}: ${getErrorMessage(error)}`);
    }
  }
}
