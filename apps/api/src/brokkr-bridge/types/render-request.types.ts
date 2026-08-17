import { z } from 'zod';

export const renderRequestSchema = z
  .object({
    request_id: z.string().uuid().describe('Idempotency / correlation token chosen by the bridge.'),
    zone_id: z.string().uuid().describe('Brokkr Zone UUID — atom-key prefix the bridge polls.'),
    bridge_id: z.string().describe('Identifier of the bridge instance enqueueing this request.'),
    domain: z
      .enum(['device_record', 'server_token', 'netplan', 'device_secret'])
      .describe('Domain identifier. MR-specific variants validate params further.'),
    reason: z
      .enum(['missing', 'stale', 'explicit'])
      .nullish()
      .describe('Why the bridge is asking the hub to render this atom. Treats JSON null the same as absent.'),
    params: z
      .record(z.unknown())
      .nullish()
      .describe(
        'Domain-specific parameters. Validated by the dispatcher branch that handles the domain. Treats JSON null the same as absent.',
      ),
  })
  .strict();

export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type RenderDomain = z.infer<typeof renderRequestSchema>['domain'];

export const ipxeIdentifierBundleSchema = z
  .object({
    mac: z.string().optional().describe('Primary NIC MAC (any format; pointer-builders normalize).'),
    ip: z.string().optional().describe('Primary NIC IP (any format; pointer-builders normalize).'),
    ipmi_mac: z.string().optional().describe('BMC NIC MAC (any format; pointer-builders normalize).'),
    ipmi_ip: z.string().optional().describe('BMC NIC IP (any format; pointer-builders normalize).'),
    system_uuid: z.string().optional().describe('SMBIOS System UUID.'),
    serial: z.string().optional().describe('System serial (SMBIOS).'),
    chassis_serial: z.string().optional().describe('Chassis serial (SMBIOS).'),
    board_serial: z.string().optional().describe('Baseboard serial (SMBIOS).'),
    manufacturer: z.string().optional().describe('Manufacturer (SMBIOS).'),
  })
  .strict();

export type IpxeIdentifierBundle = z.infer<typeof ipxeIdentifierBundleSchema>;
