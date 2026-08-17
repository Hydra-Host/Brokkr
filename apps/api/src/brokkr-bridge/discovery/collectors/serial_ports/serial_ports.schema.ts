import { SolResolvedSource } from '@repo/database';
import { z } from 'zod';

const bmcSolSchema = z
  .object({
    sol_capable: z.boolean().optional(),
    sol_enabled: z.boolean().optional(),
    hardware_channel: z.number().int().optional(),
    hardware_baud_rate: z.number().int().optional(),
    hardware_port: z.number().int().optional(),
    encryption_capable: z.boolean().optional(),
  })
  .passthrough();

const recommendationsSchema = z
  .object({
    optimal_port: z.string().optional(),
    recommended_baud: z.number().int().optional(),
    bmc_channel_mapping: z.string().optional(),
  })
  .passthrough();

const resolvedSourceSchema = z.nativeEnum(SolResolvedSource);

const resolvedSchema = z
  .object({
    port: z.string(),
    baud: z.number().int(),
    source: resolvedSourceSchema,
    confirmed: z.boolean(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

export const serialPortsSchema = z
  .object({
    hardware_platform: z.record(z.string(), z.unknown()).optional(),
    detected_ports: z.record(z.string(), z.unknown()).optional(),
    bmc_sol_hardware: bmcSolSchema.optional().default({}),
    hardware_recommendations: recommendationsSchema.optional().default({}),
    ports: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    resolved: resolvedSchema.optional(),
  })
  .passthrough();

export type SerialPortsInput = z.infer<typeof serialPortsSchema>;
