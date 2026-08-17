import { ForbiddenException } from '@nestjs/common';

import { isLoopbackAddress } from './lab-net';

export type LabExposure = 'loopback-only' | 'token-ok';

export function exposureAllowed(
  exposure: LabExposure,
  socketPeerAddr: string | undefined,
  forwardedFor: string | string[] | undefined,
): boolean {
  if (exposure === 'token-ok') return true;
  // operator opt-in for remote root-equivalent surfaces; anything but '1' denies (fail-closed).
  if (process.env.LAB_ALLOW_REMOTE_SHARP === '1') return true;
  if (!isLoopbackAddress(socketPeerAddr)) return false;
  // every forwarded hop must be loopback: effectiveClientAddress is LAB_TRUST_PROXY-gated and reads only the
  // last hop, so a proxy-laundered lan caller passes it whenever that flag is unset (standalone pnpm dev).
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (raw === undefined) return true;
  const hops = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.length > 0 && hops.every((hop) => isLoopbackAddress(hop));
}

export function assertExposure(
  exposure: LabExposure,
  socketPeerAddr: string | undefined,
  forwardedFor: string | string[] | undefined,
): void {
  if (exposureAllowed(exposure, socketPeerAddr, forwardedFor)) return;
  throw new ForbiddenException(
    'this lab route is loopback-only: a valid LAB_API_TOKEN is not sufficient, set LAB_ALLOW_REMOTE_SHARP=1 to allow remote access',
  );
}
