import { BOOT_CODE_LIST, BOOT_SEVERITIES } from '@repo/utils';
import { z } from 'zod';
import { BootTrailSchema, PxeMacSourceSchema } from './boot-trail';

export const BootReadinessFindingSchema = z.object({
  code: z
    .enum(BOOT_CODE_LIST)
    .describe('Boot code from the shared registry; title, severity and remedy derive from it'),
  severity: z.enum(BOOT_SEVERITIES).describe('Severity copied from the registry, never restated'),
  message: z.string().describe('Producer text for this machine; the remedy comes from the registry'),
  source: z.enum(['hub-prefix', 'boot-trail']).describe('Producer that raised the finding'),
  prefixId: z
    .string()
    .uuid()
    .nullable()
    .describe('Prefix the finding is about, for the DHCP settings link; null for machine-only codes'),
});
export type BootReadinessFinding = z.infer<typeof BootReadinessFindingSchema>;

export const DeviceBootReadinessSchema = z.object({
  deviceId: z.string().uuid().describe('Device evaluated'),
  prefixId: z
    .string()
    .uuid()
    .nullable()
    .describe('Prefix evaluated: the one that contains the data IP, else the zone PRIMARY prefix; null when none'),
  prefixSelection: z.enum(['containing', 'primary', 'none']).describe('How the prefix was chosen'),
  pxeMac: z.string().nullable().describe('Data MAC passed to the checks'),
  pxeInterface: z
    .string()
    .nullable()
    .describe('Name of the interface whose MAC is pxeMac; null when the device has none'),
  pxeMacSource: PxeMacSourceSchema,
  bmcAddress: z.string().nullable().describe('BMC IP passed to the split-identity check; null when none is recorded'),
  findings: z.array(BootReadinessFindingSchema).describe('Every check that did not pass, sorted by code'),
  evaluated: z
    .object({
      hubPrefix: z.boolean().describe('False when no prefix could be selected'),
      bootTrail: z.boolean().describe('False when the bridge Redis was unreadable'),
      bootedWithoutDhcp: z
        .boolean()
        .describe('The last recorded boot reached the iPXE chain with no proxy-DHCP decision from this bridge'),
    })
    .describe(
      'Which producers answered and what the trail proved; an empty findings list means nothing only when hubPrefix and bootTrail are true',
    ),
  trail: BootTrailSchema.describe('The trail the trail-derived findings came from'),
});
export type DeviceBootReadiness = z.infer<typeof DeviceBootReadinessSchema>;
