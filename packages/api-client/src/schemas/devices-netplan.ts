import { z } from 'zod';

export const NetplanPhaseSchema = z
  .enum(['live', 'deploy'])
  .describe(
    'Which network config to render. `live` is the in-rescue/discovery config bridges apply before the target OS boots; `deploy` is the post-provision config baked into the target OS image. Most callers want `live`.',
  );

export type NetplanPhase = z.infer<typeof NetplanPhaseSchema>;

export const DeviceNetplanQuerySchema = z.object({
  phase: NetplanPhaseSchema.optional().default('live'),
});

export type DeviceNetplanQuery = z.infer<typeof DeviceNetplanQuerySchema>;

export const DeviceNetplanResponseSchema = z.object({
  yaml: z
    .string()
    .min(1)
    .describe(
      'Non-empty rendered netplan YAML for the device at the requested phase. Suitable to drop directly into `/etc/netplan/*.yaml` on the device.',
    ),
});

export type DeviceNetplanResponse = z.infer<typeof DeviceNetplanResponseSchema>;
