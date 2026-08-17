import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import { SudoStatusSchema } from '../schemas/sudo';

export const sudoRoutes = {
  getSudoStatus: {
    method: 'GET',
    path: '/api/sudo/status',
    responses: { 200: SudoStatusSchema },
    summary: 'Check non-interactive sudo status',
    description:
      'Probes sudo -n so the UI knows whether fleet/datastore ops needing root can proceed silently or must first prompt for a password.',
  },
  cacheSudo: {
    method: 'POST',
    path: '/api/sudo/cache',
    body: z.object({ password: z.string() }),
    responses: { 200: z.object({ ok: z.boolean() }), 401: ErrorBodySchema, 429: ErrorBodySchema },
    summary: 'Cache the sudo credential',
    description:
      'Pipes the supplied password to sudo -S -v to refresh the sudo timestamp for this session; the password is never persisted. Returns 401 if it is rejected, and 429 either because another attempt is already in flight (at most one runs at a time) or because consecutive rejections tripped the attempt cooldown — the cooldown error names the seconds left before another attempt is accepted. Loopback-only (it accepts a plaintext credential): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
} as const;
