import { z } from 'zod';

/** Seeded as a hub fixture by sql-seed/45-zone.py, deliberately absent from the fleet topology. A
 *  fleet zone taking the name would make the ACL seeder's name lookup ambiguous. */
export const RESERVED_ZONE_NAME = 'sim-zone-maintenance';

/** The name reaches a token filename, a redis dsn password and a process-compose process name, so it
 *  is bounded to what all three accept rather than left free-form. */
export const ZONE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const ZONE_INDEX_MIN = 0;
export const ZONE_INDEX_MAX = 88;

export const ZoneSpokeSchema = z.object({
  proc: z.string().describe('process-compose name this bridge runs as, derived from the zone name and replica'),
  port: z.number().int().describe('HTTP port, derived from the zone ordinal block'),
  grpc: z.number().int().describe('gRPC port, derived the same way'),
});

export const ZoneDerivedSchema = z.object({
  uuid: z
    .string()
    .describe('Hub Zone.id, derived from the index. Index 0 keeps the legacy UUID, so moving an index moves the row'),
  ordinals: z.array(z.number().int()).describe('Bridge ordinals this zone occupies in the shared spoke band'),
  bridges: z.array(ZoneSpokeSchema).describe('Per-bridge process name and ports, as modules/spoke.nix derives them'),
  nodeCount: z.number().int().nonnegative().describe('Enabled fleet nodes assigned to this zone'),
});

export const ZoneSchema = z.object({
  name: z.string().describe('Zone name, which is the attribute key and the hub Zone.name. Free-form'),
  index: z
    .number()
    .int()
    .min(ZONE_INDEX_MIN)
    .max(ZONE_INDEX_MAX)
    .describe('0-based index. It derives the zone UUID and the spoke port block, so moving it moves both'),
  bridges: z.number().int().positive().describe('HA spoke replicas sharing this zone Redis prefix and lifecycle queue'),
  baseDeclared: z
    .boolean()
    .describe(
      'A file other than the control-center overlay declares this zone. Renaming or deleting it needs the enable tombstone rather than dropping the key',
    ),
  derived: ZoneDerivedSchema.describe('Values nothing here computes twice — Nix derives them and this reports them'),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const ZoneReconcileRowSchema = z.object({
  name: z.string().nullable().describe('Zone name, null when the hub row carried no usable name'),
  zoneId: z.string().nullable().describe('Hub Zone.id, null for a fleet zone the hub has no row for'),
  side: z
    .enum(['hub-only', 'fleet-only'])
    .describe("'hub-only' = a hub row no fleet zone declares; 'fleet-only' = a declared zone the hub has not seeded"),
  fixture: z
    .boolean()
    .describe(
      'The known seeded fixture rather than drift. Every stack has it, so reporting it as drift would always fire',
    ),
});

export const ZoneCapacitySchema = z.object({
  used: z.number().int().nonnegative().describe('Bridge ordinals the enabled zones occupy'),
  total: z
    .number()
    .int()
    .nonnegative()
    .describe('Ordinals available before the spoke band walks into its neighbour, published by Nix as labZoneCapacity'),
});

export const ZonesConfigSchema = z.object({
  seeded: z.boolean().describe('False when the devenv eval seed failed, so the zones below are bare defaults'),
  zones: z.array(ZoneSchema).describe('Enabled zones in index order'),
  capacity: ZoneCapacitySchema,
  reservedNames: z.array(z.string()).describe('Names a fleet zone may not take'),
  reconcile: z
    .array(ZoneReconcileRowSchema)
    .describe('Zones present on one side only. Empty means the hub and the fleet agree'),
  hubReadError: z
    .string()
    .nullable()
    .describe(
      'Null when the hub Zone rows were read. Otherwise the reconcile list is not a measurement, and an empty one must not read as agreement',
    ),
});
export type ZonesConfig = z.infer<typeof ZonesConfigSchema>;

export const ZoneWriteSchema = z.object({
  name: z.string().min(1).regex(ZONE_NAME_RE),
  index: z.number().int().min(ZONE_INDEX_MIN).max(ZONE_INDEX_MAX),
  bridges: z.number().int().positive(),
});
export type ZoneWrite = z.infer<typeof ZoneWriteSchema>;

/** A rename and a delete-plus-create are indistinguishable from the desired set alone, and they cost
 *  different things, so the caller says which it meant. */
export const ZoneRenameSchema = z.object({
  from: z.string().min(1).describe('Existing zone name'),
  to: z.string().min(1).describe('New name, at the same index'),
});

export const ZoneStepSchema = z.object({
  id: z.string().describe('Name of the step, as the op reports it in its log'),
  label: z.string().describe('What this step does'),
  why: z.string().describe('What breaks if it runs out of order'),
});

export const ZoneApplyPlanSchema = z.object({
  steps: z
    .array(ZoneStepSchema)
    .describe(
      'Ordered steps the zone-seed op performs to make the saved zone set live. The order is the point: a rename re-derives the Redis ACL password from the new name, so restarting a bridge before the seed leaves it dialling with a password the ACL user does not hold. One op runs them, so the order cannot be got wrong.',
    ),
  fullRebuild: z.boolean().describe('A node changed zone, which is an identity field, so the fleet rebuilds'),
});
export type ZoneApplyPlan = z.infer<typeof ZoneApplyPlanSchema>;
