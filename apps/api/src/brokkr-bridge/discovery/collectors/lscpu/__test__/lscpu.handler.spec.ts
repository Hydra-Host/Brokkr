import { describe, expect, it } from 'vitest';
import { LscpuHandler } from '../lscpu.handler';

describe('LscpuHandler', () => {
  const handler = new LscpuHandler();

  it('is a no-op — CPU counts are projected from Cpu rows (ghw_cpu)', async () => {
    expect(await handler.handle()).toEqual({});
  });

  it('rejects non-positive counts', () => {
    expect(handler.schema.safeParse({ total_cpu_sockets: 0, total_cpu_cores: 1, total_cpu_threads: 1 }).success).toBe(
      false,
    );
  });

  it('rejects missing required counts', () => {
    expect(handler.schema.safeParse({ total_cpu_sockets: 1 }).success).toBe(false);
  });
});
