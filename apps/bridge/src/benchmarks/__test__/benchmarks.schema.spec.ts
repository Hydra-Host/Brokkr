import { describe, expect, it } from 'vitest';

import { benchmarksSagaPayloadSchema } from '../benchmarks.schema';

const VALID = {
  device_id: 'e5f6a7b8-1234-5678-9abc-def012345678',
  gpu_burn_job_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  nccl_job_id: 'f0e1d2c3-b4a5-6789-0fed-cba987654321',
  benchmark_type: 'all',
} as const;

describe('benchmarksSagaPayloadSchema', () => {
  it('accepts a fully populated valid payload', () => {
    const parsed = benchmarksSagaPayloadSchema.parse(VALID);
    expect(parsed.device_id).toBe(VALID.device_id);
    expect(parsed.benchmark_type).toBe('all');
  });

  it.each(['device_id', 'gpu_burn_job_id', 'nccl_job_id', 'benchmark_type'] as const)(
    'rejects payload missing required field %s',
    (field) => {
      const { [field]: _omitted, ...partial } = VALID;
      expect(() => benchmarksSagaPayloadSchema.parse(partial)).toThrow();
    },
  );

  it('rejects unknown benchmark_type value', () => {
    expect(() => benchmarksSagaPayloadSchema.parse({ ...VALID, benchmark_type: 'unknown' })).toThrow();
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() => benchmarksSagaPayloadSchema.parse({ ...VALID, rogue: 'x' })).toThrow();
  });

  it.each(['device_id', 'gpu_burn_job_id', 'nccl_job_id'] as const)('rejects non-string %s', (field) => {
    expect(() => benchmarksSagaPayloadSchema.parse({ ...VALID, [field]: 123 })).toThrow();
  });
});
