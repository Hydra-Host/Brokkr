import { DiskSpecSchema } from '@repo/local-lab-contract';
import { z } from 'zod';

const EffectiveBmcSchema = z.object({ username: z.string().optional(), password: z.string().optional() });

export const EffectiveNodeSchema = z
  .object({
    name: z.string().min(1),
    ipmi_mac: z.string().min(1),
    data_mac: z.string().min(1),
    zone: z.string().optional(),
    cpus: z.number().int().positive().optional(),
    memory_mb: z.number().int().positive().optional(),
    disk_gb: z.number().int().positive().optional(),
    disks: z.array(DiskSpecSchema).optional(),
    passthrough: z.array(z.string()).optional(),
    nics: z.array(z.object({ mac: z.string().min(1) }).catchall(z.unknown())).optional(),
    data_mtu: z.number().int().nullable().optional(),
    arch: z.string().nullable().optional(),
    network_type: z.enum(['nat', 'public']).nullable().optional(),
    ip: z.string().nullable().optional(),
    bmc_ip: z.string().nullable().optional(),
    bmc: EffectiveBmcSchema.nullable().optional(),
    console_port: z.number().int().positive().nullish(),
    seed_as_server: z.boolean().optional(),
  })
  .passthrough();
export type EffectiveNode = z.infer<typeof EffectiveNodeSchema>;

export const EffectiveNetworkSchema = z
  .object({
    name: z.string().optional(),
    cidr: z.string().optional(),
    bmc_cidr: z.string().optional(),
    domain: z.string().optional(),
    dhcp: z.boolean().optional(),
    rendered_netplan: z.boolean().optional(),
  })
  .passthrough();
export type EffectiveNetwork = z.infer<typeof EffectiveNetworkSchema>;

export const EffectiveDefaultsSchema = z
  .object({
    cpus: z.number().int().positive().optional(),
    memory_mb: z.number().int().positive().optional(),
    disk_gb: z.number().int().positive().optional(),
    disks: z.array(DiskSpecSchema).optional(),
    passthrough: z.array(z.string()).optional(),
    bmc: EffectiveBmcSchema.nullable().optional(),
    arch: z.string().optional(),
  })
  .passthrough();
export type EffectiveDefaults = z.infer<typeof EffectiveDefaultsSchema>;
