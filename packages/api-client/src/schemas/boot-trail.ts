import { PXE_OUTCOMES } from '@repo/utils';
import { z } from 'zod';

export const PxeOutcomeSchema = z
  .enum(PXE_OUTCOMES)
  .describe('Last proxy-DHCP decision the bridge recorded for the PXE MAC');
export type PxeOutcome = z.infer<typeof PxeOutcomeSchema>;

export const PxeDecisionHashSchema = z.object({
  outcome: PxeOutcomeSchema,
  at: z.string().regex(/^\d+$/).describe('Epoch milliseconds as a string, the form the bridge HSETs'),
});

export const ChainHitValueSchema = z.object({
  atMs: z.number().int().nonnegative().describe('Epoch milliseconds when the machine fetched the iPXE chain script'),
  deviceId: z.string().nullable().describe('Device the bridge matched the MAC to; null when it knew none'),
});

export const BootTrailSchema = z.object({
  pxe: z
    .object({ outcome: PxeOutcomeSchema, atMs: z.number().int().describe('Epoch milliseconds of the decision') })
    .nullable()
    .describe('Null when no PXE request reached the bridge inside the 7-day record window'),
  chainReached: z
    .boolean()
    .nullable()
    .describe('True when iPXE from this MAC fetched the chain script; null when the bridge Redis could not be read'),
  chainAtMs: z
    .number()
    .int()
    .nullable()
    .describe(
      'Epoch milliseconds of the last chain hit; null when only the 30-day discovery marker proves the hit, or when unreadable',
    ),
  chainDeviceMismatch: z
    .boolean()
    .describe('True when the recorded chain hit names a different device id than this one'),
  readError: z
    .string()
    .nullable()
    .describe('Set when Redis could not be read; chainReached and pxe are then unknown, not false'),
});
export type BootTrail = z.infer<typeof BootTrailSchema>;

export const BootExpectedSchema = z.object({
  expected: z.boolean().describe('True while the hub expects this machine to network-boot'),
  since: z
    .string()
    .datetime()
    .nullable()
    .describe('When the expectation started: the job createdAt or the status change; null when not expected'),
  reason: z
    .enum(['provisioning-status', 'active-job', 'none'])
    .describe(
      "'provisioning-status' when lifecycleStatus is PROVISIONING; 'active-job' when a non-terminal provision, reprovision or deprovision job exists; 'none' otherwise",
    ),
});
export type BootExpected = z.infer<typeof BootExpectedSchema>;

export const PxeMacSourceSchema = z
  .enum(['marker', 'address', 'name-order'])
  .nullable()
  .describe(
    "Why that interface: 'marker' when the bridge recorded a boot for it, 'address' when it holds an IP, 'name-order' as the last resort",
  );

export const DeviceBootTrailSchema = z.object({
  deviceId: z.string().uuid().describe('Device the trail was read for'),
  pxeMac: z
    .string()
    .nullable()
    .describe('Canonical data-interface MAC used as the PXE MAC; null when the device has none'),
  pxeInterface: z
    .string()
    .nullable()
    .describe('Name of the interface whose MAC is pxeMac; null when the device has none'),
  pxeMacSource: PxeMacSourceSchema,
  candidateMacs: z.array(z.string()).describe('Other live non-management MACs on the device, in interface-name order'),
  zoneId: z.string().uuid().nullable().describe('Zone whose bridge Redis was read'),
  trail: BootTrailSchema,
  bootExpected: BootExpectedSchema.describe(
    'Drives whether silence is a finding. Outside an expected boot, a missing PXE request is plain text, not PXE-111',
  ),
  readAt: z.string().datetime().describe('Hub clock at read time'),
});
export type DeviceBootTrail = z.infer<typeof DeviceBootTrailSchema>;
