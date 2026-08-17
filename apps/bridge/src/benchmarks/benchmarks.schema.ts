import { z } from 'zod';

export const benchmarksSagaPayloadSchema = z
  .object({
    device_id: z.string(),
    gpu_burn_job_id: z.string(),
    nccl_job_id: z.string(),
    benchmark_type: z.literal('all'),
  })
  .strict();

export type BenchmarksSagaPayload = z.infer<typeof benchmarksSagaPayloadSchema>;
