import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { getErrorMessage } from '@repo/utils';
import { AuditStore } from '../ledger/audit-store';
import { PORTS } from '../ports';
import { type AuditRequest, auditParams, isSafeMethod } from './audit-row';
import {
  type Capability,
  capabilityAllowed,
  capabilityRefusal,
  requestToken,
  unauthenticatedRefusal,
} from './lab-capability';
import { auditOriginColumns, currentOrigin } from './lab-context';
import { effectiveClientAddress, isLoopbackAddress, resolvePrincipal } from './lab-net';
import { LAB_PUBLIC_ROUTE, LAB_ROUTE, type LabRouteOptions } from './lab-route';

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

// never the Host header (caller-supplied — dns rebinding) and never os.hostname(): a LAN client reaches us by
// whatever name ITS resolver knows, so matching our own name would deny the common case. Token holders skip this.
export function isMutationOriginAllowed(origin: string, localAddress: string | undefined): boolean {
  if (labCorsOrigins().includes(origin)) return true;
  const source = parseUrl(origin);
  if (!source || ![labWebPort(), String(PORTS.lab)].includes(source.port)) return false;
  // new URL keeps the brackets on an ipv6 hostname
  const hostname = source.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isLoopbackAddress(hostname)) return true;
  return localAddress !== undefined && hostname === localAddress;
}

const MAX_CONSECUTIVE_REJECTIONS = 5;
const REJECTION_COOLDOWN_MS = 30_000;
// deliberately far longer than the cooldown: at parity a guesser just waits out the decay between
// every four attempts and the threshold is never reached
const REJECTION_IDLE_RESET_MS = 10 * REJECTION_COOLDOWN_MS;
// bounds what a caller rotating source addresses can make the process hold
const MAX_TRACKED_ADDRESSES = 1_024;

interface AddressBackoff {
  rejections: number;
  cooldownUntil: number;
  lastRejectedAt: number;
}

/** Per-caller, unlike the process-global sudo cooldown it is modelled on: one address guessing tokens
 *  must not lock every other caller out. */
export class AuthBackoff {
  private readonly byAddress = new Map<string, AddressBackoff>();

  /** Remaining cooldown in whole seconds, 0 when the caller may try again. */
  remainingSeconds(address: string): number {
    const entry = this.byAddress.get(address);
    if (entry === undefined) return 0;
    return Math.max(0, Math.ceil((entry.cooldownUntil - Date.now()) / 1000));
  }

  reject(address: string): void {
    this.evictExpired();
    const now = Date.now();
    const prior = this.byAddress.get(address);
    // decays on idle time, never on a successful request: the api token is shared with every LAN
    // browser, so presenting a valid one cannot be read as "is not guessing the other one"
    const fresh = prior !== undefined && prior.lastRejectedAt + REJECTION_IDLE_RESET_MS > now;
    const entry = fresh ? prior : { rejections: 0, cooldownUntil: 0, lastRejectedAt: 0 };
    entry.rejections += 1;
    entry.lastRejectedAt = now;
    // the counter is deliberately not cleared, so every further rejection re-arms the cooldown
    if (entry.rejections >= MAX_CONSECUTIVE_REJECTIONS) entry.cooldownUntil = now + REJECTION_COOLDOWN_MS;
    // re-inserted, not updated in place, so Map order stays least-recently-rejected first
    this.byAddress.delete(address);
    this.byAddress.set(address, entry);
  }

  private evictExpired(): void {
    if (this.byAddress.size < MAX_TRACKED_ADDRESSES) return;
    const now = Date.now();
    // idle, not merely un-cooled: a partial run of guesses has no cooldown yet, and dropping it
    // would hand the guesser a counter reset for the price of filling the map.
    for (const [address, entry] of this.byAddress) {
      if (entry.lastRejectedAt + REJECTION_IDLE_RESET_MS <= now) this.byAddress.delete(address);
    }
    // nothing idle enough under a flood of fresh addresses, so fall back to least-recently-rejected
    for (const address of this.byAddress.keys()) {
      if (this.byAddress.size < MAX_TRACKED_ADDRESSES) break;
      this.byAddress.delete(address);
    }
  }
}

/** Audits its own denials: guards run before interceptors, so a rejected request is invisible to the
 *  audit interceptor and would otherwise leave no trace of who tried what. */
@Injectable()
export class LabAuthGuard implements CanActivate {
  private readonly log = new Logger(LabAuthGuard.name);
  private readonly backoff = new AuthBackoff();

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditStore,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.get<true | undefined>(LAB_PUBLIC_ROUTE, ctx.getHandler()) === true) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const peer = req.ip ?? req.socket.remoteAddress;
    const forwardedFor = req.headers['x-forwarded-for'];
    const route = this.reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, ctx.getHandler());
    // 'per-run' routes carry only the floor here; their own guard reads the run's requirement
    const declared = route?.capability ?? 'read';
    const required: Capability = declared === 'per-run' ? 'read' : declared;
    const address = effectiveClientAddress(peer, forwardedFor) ?? 'unknown';

    const cooldown = this.backoff.remainingSeconds(address);
    if (cooldown > 0) {
      return this.deny(
        ctx,
        req,
        route,
        new HttpException(`too many rejected lab API tokens; retry in ${cooldown}s`, HttpStatus.TOO_MANY_REQUESTS),
      );
    }

    const provided = requestToken(req);
    const principal = resolvePrincipal(provided);
    if (!capabilityAllowed('read', principal, peer, forwardedFor)) {
      // only a presented token counts as an attempt: a caller with none is not guessing one
      if (provided !== undefined) this.backoff.reject(address);
      return this.deny(ctx, req, route, unauthenticatedRefusal());
    }
    if (!capabilityAllowed(required, principal, peer, forwardedFor)) {
      return this.deny(ctx, req, route, capabilityRefusal(required));
    }
    return true;
  }

  private deny(ctx: ExecutionContext, req: Request, route: LabRouteOptions | undefined, denial: HttpException): never {
    this.recordDenial(ctx, req, denial, route !== undefined);
    throw denial;
  }

  /** No duration: no handler ran, and a faked 0 would read as an instant success. */
  private recordDenial(ctx: ExecutionContext, req: AuditRequest, denial: unknown, annotated: boolean): void {
    // an un-annotated safe method is the only unrecorded denial: a probe flood must not evict real history
    if (!annotated && isSafeMethod(req.method)) return;
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
        ...auditOriginColumns(currentOrigin()),
        error: getErrorMessage(denial),
      });
    } catch (error) {
      this.log.warn(`denial audit write failed for ${req.method} ${req.path}: ${getErrorMessage(error)}`);
    }
  }
}
