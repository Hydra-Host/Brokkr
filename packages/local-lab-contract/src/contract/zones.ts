import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import { ZoneApplyPlanSchema, ZoneRenameSchema, ZonesConfigSchema, ZoneWriteSchema } from '../schemas/zones';

export const zonesRoutes = {
  getZonesConfig: {
    method: 'GET',
    path: '/api/zones/config',
    responses: { 200: ZonesConfigSchema },
    summary: 'Get the declared zones with their derived values',
    description:
      'Read-only: every enabled zone with what the overlay sets (name, index, bridges) beside what Nix derives from it (zone UUID, bridge ordinals, per-bridge ports, node count), plus the ordinal budget, the reserved names, and how the declared set compares with the hub Zone rows. A zone present on one side only is listed rather than reconciled, and the known seeded fixture is marked as such so it is not reported as drift on every stack.',
  },
  putZonesConfig: {
    method: 'PUT',
    path: '/api/zones/config',
    body: z.object({
      zones: z
        .array(ZoneWriteSchema)
        .min(1)
        .describe('The whole desired zone set. A declared zone absent from it is tombstoned, not dropped'),
      rename: ZoneRenameSchema.optional().describe(
        'Names one zone as renamed rather than deleted and re-created, because the two cost different things',
      ),
      nodeZones: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Node name → zone. The engine requires every node to name a zone once two or more are declared, so adding a second zone must fill these in the same write',
        ),
    }),
    responses: {
      200: z.object({
        ok: z.boolean(),
        plan: ZoneApplyPlanSchema.describe('Ordered steps to make the saved set live'),
      }),
      400: ErrorBodySchema.describe(
        'The zone set was refused, with the reason: a duplicate name or index, an index outside its range, a node naming an undeclared zone, a node left without a zone while two or more are declared, a delete of a zone that still owns nodes, a delete of the last zone, a rename combined with an index move, a reserved name, a derived process-name collision, or more bridges in total than the ordinal budget holds.',
      ),
      503: ErrorBodySchema.describe(
        'The devenv eval seed failed, so the control center does not know the live overlay and nothing was written.',
      ),
    },
    summary: 'Write the declared zone set',
    description:
      'Persists the zone set to the stack overlay. Every rule the engine enforces at load is checked here instead, because those failures otherwise surface minutes into an apply run. Returns the ordered steps that make the set live: a rename re-derives the Redis ACL password from the new zone name while the ACL username stays keyed to the unchanged UUID, so seeding must precede the redeploy or the bridge dials with a password the user does not hold. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
} as const;
