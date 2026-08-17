import { z } from 'zod';

export const checkCcMode = {
  input: z.object({}),
  output: z.object({
    cc_enabled: z
      .boolean()
      .describe(
        'True iff any detected NVIDIA GPU reports Confidential Compute enabled. Benchmarks must be skipped when true.',
      ),
    skip_benchmarks: z
      .boolean()
      .optional()
      .describe("Convenience flag mirroring `cc_enabled`; set so callers don't need to re-derive the decision."),
    cc_check_error: z
      .string()
      .optional()
      .describe(
        'Error message when the CC probe itself failed to run. Non-fatal — the saga treats cc_enabled as false and proceeds.',
      ),
  }),
} as const;

export const BenchmarkType = z
  .enum(['all', 'gpu_burn', 'nccl'])
  .describe("Which benchmarks to run: 'all' (gpu-burn + NCCL), 'gpu_burn' (skip NCCL), or 'nccl' (skip gpu-burn).");
export type BenchmarkType = z.infer<typeof BenchmarkType>;

export const runBenchmarks = {
  input: z.object({
    benchmark_type: BenchmarkType.default('all').describe('Which benchmark(s) to run. See BenchmarkType.'),
    duration: z
      .string()
      .default('30m')
      .describe("Duration string passed to gpu-burn, e.g. '30m', '1h'. NCCL duration is fixed per-iteration."),
  }),
  output: z.object({
    benchmark_type: z.string().describe('Echoes the input benchmark_type for downstream result classification.'),
    gpu_benchmarks: z
      .record(z.string(), z.unknown())
      .describe(
        'Merged per-benchmark result dict, e.g. { gpu_burn: {...}, nccl: {...} }. Opaque shape — hub consumes as JSON.',
      ),
    gpu_burn_passed: z.boolean().describe('Overall gpu-burn pass/fail verdict; false when skipped.'),
    nccl_passed: z.boolean().describe('Overall NCCL pass/fail verdict; false when skipped.'),
  }),
} as const;

export const operations = {
  checkCcMode,
  runBenchmarks,
} as const;
