import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { capabilityRefusalMessage, LAB_CAPABILITIES, type LabCapability } from '@repo/local-lab-contract';
import type { IncomingHttpHeaders } from 'node:http';

import { extractToken, isLoopbackAddress, resolvePrincipal } from './lab-net';

export type Capability = LabCapability;

/** `per-run` defers to a route-level guard that reads the requirement off the run's own ledger row. */
export type RouteCapability = Capability | 'per-run';

const ORDER: readonly Capability[] = LAB_CAPABILITIES;

export function capabilityRank(capability: Capability): number {
  return ORDER.indexOf(capability);
}

export type PrincipalId = 'api' | 'host';

/** A token holder named by the highest capability it reaches; the ordering implies everything below. */
export interface Principal {
  id: PrincipalId;
  ceiling: Capability;
}

export type LabMode = 'loopback' | 'direct' | 'fronted';

// an unrecognised value is not a posture we can reason about, so it takes the one that grants nothing by address
export function labMode(): LabMode {
  const raw = process.env.LAB_MODE;
  if (raw === undefined || raw === '') return 'loopback';
  return raw === 'loopback' || raw === 'direct' ? raw : 'fronted';
}

/** True only for a request that cannot have crossed a network: `effectiveClientAddress` reads the last
 *  hop only, so a proxy-laundered LAN caller passes it whenever LAB_TRUST_PROXY is unset. */
function originatedOnThisHost(
  socketPeerAddr: string | undefined,
  forwardedFor: string | string[] | undefined,
): boolean {
  if (!isLoopbackAddress(socketPeerAddr)) return false;
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (raw === undefined) return true;
  const hops = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.length > 0 && hops.every((hop) => isLoopbackAddress(hop));
}

/** Refusal is the default: behind a terminator every caller arrives on loopback, so `fronted` drops
 *  the address branch and everybody presents a token. */
export function capabilityAllowed(
  required: Capability,
  principal: Principal | null,
  socketPeerAddr: string | undefined,
  forwardedFor: string | string[] | undefined,
): boolean {
  if (principal !== null && capabilityRank(principal.ceiling) >= capabilityRank(required)) return true;
  if (labMode() !== 'fronted' && originatedOnThisHost(socketPeerAddr, forwardedFor)) return true;
  return false;
}

/** The request surface a capability decision reads — structural, so a raw upgrade socket qualifies. */
export interface CapabilityRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: IncomingHttpHeaders;
  query?: Record<string, unknown>;
}

function queryTokenOf(req: CapabilityRequest): string | undefined {
  const raw = req.query?.token;
  return typeof raw === 'string' ? raw : undefined;
}

export function requestToken(req: CapabilityRequest): string | undefined {
  return extractToken(req.headers.authorization, req.headers['x-lab-token'], queryTokenOf(req));
}

export function requestPrincipal(req: CapabilityRequest): Principal | null {
  return resolvePrincipal(requestToken(req));
}

export function requestAllows(required: Capability, req: CapabilityRequest): boolean {
  return capabilityAllowed(
    required,
    requestPrincipal(req),
    req.ip ?? req.socket?.remoteAddress,
    req.headers['x-forwarded-for'],
  );
}

/** `fronted` drops the address branch, so a message naming non-loopback callers there would describe
 *  the one case the mode does not have. */
export function unauthenticatedRefusal(): UnauthorizedException {
  return new UnauthorizedException(
    labMode() === 'fronted'
      ? 'lab control API requires a valid lab token from every caller, loopback included: a terminator dials 127.0.0.1, so a loopback peer is whoever the front door serves'
      : 'lab control API requires a valid lab token for non-loopback requests',
  );
}

export function capabilityRefusal(required: Capability): ForbiddenException {
  return new ForbiddenException(capabilityRefusalMessage(required));
}
