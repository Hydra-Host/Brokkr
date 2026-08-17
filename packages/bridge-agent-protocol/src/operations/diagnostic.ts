import { z } from 'zod';

const emptyInput = z.object({});

function diagnosticOutput(name: string) {
  return z.object({
    [name]: z
      .record(z.string(), z.unknown())
      .describe(`Nested health-report for the ${name} diagnostic. Opaque shape — hub consumes as JSON.`),
  });
}

export const gpu = {
  input: emptyInput,
  output: diagnosticOutput('gpu'),
} as const;

export const thermal = {
  input: emptyInput,
  output: diagnosticOutput('thermal'),
} as const;

export const storage = {
  input: emptyInput,
  output: diagnosticOutput('storage'),
} as const;

export const memory = {
  input: emptyInput,
  output: diagnosticOutput('memory'),
} as const;

export const network = {
  input: emptyInput,
  output: diagnosticOutput('network'),
} as const;

export const performance = {
  input: emptyInput,
  output: diagnosticOutput('performance'),
} as const;

export const power = {
  input: emptyInput,
  output: diagnosticOutput('power'),
} as const;

export const system = {
  input: emptyInput,
  output: diagnosticOutput('system'),
} as const;

export const battery = {
  input: emptyInput,
  output: diagnosticOutput('battery'),
} as const;

export const runAll = {
  input: emptyInput,
  output: z
    .record(z.string(), z.unknown())
    .describe(
      "Flat merged record: one key per diagnostic ('gpu', 'thermal', ...) plus a `diagnostics_metadata` tail block summarising totals, successful, failed, job_id.",
    ),
} as const;

export const write_serial_tokens = {
  input: z.object({
    writes: z
      .array(
        z.object({
          port: z.string().describe("Port name without /dev prefix (e.g. 'ttyS0')."),
          token: z.string().describe('Unique sentinel; bridge correlates to identify which port surfaced on SOL.'),
          baud: z.number().int().describe('Baud rate to set via stty before writing.'),
        }),
      )
      .describe('Per-port writes; executed sequentially.'),
    settle_ms: z.number().int().optional().describe('Optional initial pause to let the SOL listener subscribe.'),
  }),
  output: z.object({
    writes: z
      .array(
        z.object({
          port: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      )
      .describe('One entry per requested write, in input order.'),
    total_duration_ms: z.number().int(),
  }),
} as const;

export const operations = {
  gpu,
  thermal,
  storage,
  memory,
  network,
  performance,
  power,
  system,
  battery,
  runAll,
  write_serial_tokens,
} as const;
