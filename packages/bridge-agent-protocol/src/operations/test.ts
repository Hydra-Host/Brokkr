import { z } from 'zod';

export const TestDuration = z
  .string()
  .default('30m')
  .describe("Duration string, e.g. '5m', '30m', '1h'. Applied per sub-test that respects it.");
export const TestIntensity = z
  .enum(['low', 'normal', 'high'])
  .default('normal')
  .describe('Load intensity level. `low` is a quick sanity pass; `high` approaches the hardware ceiling.');

export const connectivity = {
  input: z.object({}),
  output: z.object({
    connectivity: z
      .record(z.string(), z.unknown())
      .describe(
        'Nested result dict: per-probe status (BMC, LLDP, internet, DNS, etc.) plus an overall verdict. Hub-opaque.',
      ),
  }),
} as const;

export const stress = {
  input: z.object({
    duration: TestDuration,
    intensity: TestIntensity,
  }),
  output: z.object({
    stress: z
      .record(z.string(), z.unknown())
      .describe(
        'Nested result dict: per-subsystem load results (cpu, memory, storage, network) with status/error fields. Hub-opaque.',
      ),
  }),
} as const;

export const performance = {
  input: z.object({
    duration: TestDuration,
  }),
  output: z.object({
    performance: z
      .record(z.string(), z.unknown())
      .describe('Nested result dict: per-subsystem benchmark numbers and pass/fail verdicts. Hub-opaque.'),
  }),
} as const;

export const security = {
  input: z.object({}),
  output: z.object({
    security: z
      .record(z.string(), z.unknown())
      .describe(
        'Nested result dict: per-probe security posture checks (TDX, TEE, TPM, secure boot, memory encryption, certs). Hub-opaque.',
      ),
  }),
} as const;

export const runTestSuite = {
  input: z.object({
    duration: TestDuration,
    intensity: TestIntensity,
  }),
  output: z
    .record(z.string(), z.unknown())
    .describe(
      'Flat merged record keyed by sub-test name (connectivity, gpu_burn_in, nccl, performance, security, stress) plus a `testing_metadata` tail block.',
    ),
} as const;

export const operations = {
  connectivity,
  stress,
  performance,
  security,
  runTestSuite,
} as const;
