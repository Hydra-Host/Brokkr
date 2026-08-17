import { z } from 'zod';

export const kernelParamsSchema = z
  .object({
    current_cmdline: z.string().min(1),
    parsed_parameters: z.record(z.string(), z.array(z.string())).optional(),
    ubuntu_version: z.string().optional(),
    grub_config: z
      .object({
        cmdline_linux: z.string().optional(),
        serial_command: z.string().optional(),
        terminal: z.string().optional(),
      })
      .passthrough()
      .optional(),
    hardware_analysis: z.record(z.string(), z.unknown()).optional(),
    issues_detected: z.array(z.unknown()).optional().default([]),
    recommendations: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type KernelParamsInput = z.infer<typeof kernelParamsSchema>;
