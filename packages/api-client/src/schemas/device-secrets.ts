import { z } from 'zod';

export const DeviceSecretPurposeSchema = z
  .enum(['BMC', 'CONSOLE'])
  .describe('What the secret authenticates to (scales: SWITCH, PDU…).');

export const DeviceSecretKindSchema = z
  .enum(['USER', 'KEY', 'TOKEN', 'CERT'])
  .describe('Decrypted shape: USER={user,pass}, KEY={public?,private}, TOKEN={token}, CERT={cert,key?}.');

export const DeviceSecretDeviceParamsSchema = z.object({
  deviceId: z.string().uuid('deviceId must be a valid UUID').describe('UUID of the Device whose secrets are managed.'),
});

export const DeviceSecretVersionParamsSchema = z.object({
  deviceId: z.string().uuid('deviceId must be a valid UUID').describe('UUID of the Device.'),
  purpose: DeviceSecretPurposeSchema,
  version: z.coerce.number().int().positive().describe('1-based version within (device, purpose).'),
});

export const DeviceSecretRevealStatusParamsSchema = z.object({
  deviceId: z.string().uuid('deviceId must be a valid UUID').describe('UUID of the Device.'),
  requestId: z.string().uuid('requestId must be a valid UUID').describe('Reveal request id returned by the POST.'),
});

export const DeviceSecretVersionMetaSchema = z.object({
  version: z
    .number()
    .int()
    .positive()
    .describe('Monotonic version; current = highest non-invalidated for the purpose.'),
  purpose: DeviceSecretPurposeSchema,
  kind: DeviceSecretKindSchema,
  createdAt: z.string().datetime().describe('When this version was written.'),
  createdBy: z.string().describe('Email of the user who wrote it (or user id when no email).'),
  invalidatedAt: z
    .string()
    .datetime()
    .nullable()
    .describe('Set when the sealing zone-key generation was superseded — the secret is unopenable and needs re-entry.'),
});

export const DeviceSecretVersionListSchema = z
  .array(DeviceSecretVersionMetaSchema)
  .describe('Secret version history for the device, newest first per purpose. Metadata only — no plaintext.');

export const DeviceSecretWriteRequestSchema = z.object({
  purpose: DeviceSecretPurposeSchema,
  kind: DeviceSecretKindSchema,
  secret: z
    .record(z.string())
    .describe(
      'Plaintext key/value material, shape per kind (e.g. {user,pass} for USER). Sealed to the zone; never stored in the clear.',
    ),
});

export const DeviceSecretRevealRequestResponseSchema = z.object({
  requestId: z.string().uuid().describe('Poll the reveal-status endpoint with this id until status is ready.'),
  status: z.literal('pending').describe('The reveal was queued to the zone bridge; poll for the result.'),
});

export const DeviceSecretRevealStatusResponseSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('pending').describe('Bridge round-trip still in flight; keep polling.'),
      secret: z.null().describe('Always null while pending.'),
    }),
    z.object({
      status: z.literal('ready').describe('Secret present and returned once.'),
      secret: z.record(z.string()).describe('The decrypted secret key/value material (returned once).'),
    }),
    z.object({
      status: z.literal('unavailable').describe('Bridge offline/timed out or the secret was invalidated.'),
      secret: z.null().describe('Always null when unavailable.'),
    }),
  ])
  .describe('Reveal-status result; `secret` is populated only on the ready variant.');
