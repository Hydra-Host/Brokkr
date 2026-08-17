import { describe, expect, it } from 'vitest';
import { GhwMemoryHandler } from '../ghw_memory.handler';

describe('GhwMemoryHandler', () => {
  const handler = new GhwMemoryHandler();

  it('is a no-op — total RAM is sourced from MemoryConfig (dmidecode_memory)', async () => {
    expect(await handler.handle()).toEqual({});
  });

  it('rejects negative or missing total_physical_bytes', () => {
    expect(handler.schema.safeParse({ memory: { total_physical_bytes: -1 } }).success).toBe(false);
    expect(handler.schema.safeParse({ memory: {} }).success).toBe(false);
  });
});
