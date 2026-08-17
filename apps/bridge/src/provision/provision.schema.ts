import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

const serverTokenAtomSchema = z
  .object({
    deployment_os_token: z.string().min(1),
    endpoint: z.string().min(1),
    exp: z.number().int().optional(),
  })
  .strict();

const osLayerEntrySchema = z
  .object({
    layer: z.string().min(1),
    sha256: z.string().min(1),
    compression: z.enum(['zstd', 'gzip']),
    stack_position: z.number().int().min(0),
  })
  .strict();

const platformSchema = z
  .object({
    slug: z.string().min(1),
    codename: z.string().min(1),
    os_version: z.string().min(1),
    os_distro: z.string().min(1),
    variant: z.string().min(1),
  })
  .strict();

export const deviceDataSchema = z.object({
  netplan: z.string().nullish(),
  gpu_model: z.string().nullish(),
  purge_ttys: z.boolean().default(false),
  serial_port: z.string().nullish(),
  serial_baud: z.number().int().nullish(),
  device_type: z.string().nullish(),
  network_type: z.string().nullish(),
});

const lifecycleDataSchema = z
  .object({
    hostname: z.string().min(1),
    node_desc: z.string().min(1),
    disk_layouts: z.array(z.record(z.unknown())),
    pubkeys: z.array(z.string()),
    user_data: z.unknown().nullish(),
    ipxe_url: z.string().nullish(),
    os_layers: z.array(osLayerEntrySchema).nullish(),
    password_hash: z.string().nullish(),
    server_token: serverTokenAtomSchema.nullish(),
  })
  .strict()
  .refine((data) => Boolean(data.ipxe_url) || data.server_token != null, {
    message: 'server_token is required on the OS-deploy path (unless ipxe_url is set)',
  });

export const provisionSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    status: z.enum(['provisioning', 'reprovisioning']),
    tee_enabled: z.boolean(),
    tee_requested: z.boolean().default(false),
    boot_device: z.string().min(1),
    platform: platformSchema,
    device_data: deviceDataSchema,
    lifecycle_data: lifecycleDataSchema,
  })
  .strict();

export type ProvisionSagaPayload = z.infer<typeof provisionSagaPayloadSchema>;
