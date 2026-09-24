// Must stay in sync with hub's renderRequestSchema at apps/api/src/brokkr-bridge/types/render-request.types.ts.

import { RENDER_DOMAINS } from '@repo/utils';
import { z } from 'zod';

export const renderReasonSchema = z.enum(['missing', 'stale', 'explicit']);

export type RenderReason = z.infer<typeof renderReasonSchema>;

export const renderRequestSchema = z
  .object({
    request_id: z.string().uuid(),
    zone_id: z.string().uuid(),
    bridge_id: z.string(),
    domain: z.enum(RENDER_DOMAINS),
    reason: renderReasonSchema.nullable().default(null),
    params: z.record(z.unknown()).nullable().default(null),
  })
  .strict();

export type RenderRequest = z.infer<typeof renderRequestSchema>;
