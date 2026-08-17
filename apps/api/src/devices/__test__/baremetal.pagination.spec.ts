import { MIB_PER_GIB } from '@repo/utils';
import { describe, expect, it } from 'vitest';
import { devicesPaginationConfig } from '../baremetal.pagination';

describe('devicesPaginationConfig.advancedFilterFields.memory', () => {
  it('maps GB filter values to MemoryConfig MiB values', () => {
    const memory = devicesPaginationConfig.advancedFilterFields?.memory;
    expect(memory?.prismaField).toBe('memoryConfig.totalSizeMb');
    expect(memory?.valueMultiplier).toBe(MIB_PER_GIB);
  });
});
