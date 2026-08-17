import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DmidecodeMemoryHandler } from '../dmidecode_memory.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/dmidecode_memory', `${name}.json`), 'utf8'));

describe('DmidecodeMemoryHandler', () => {
  const handler = new DmidecodeMemoryHandler();

  it('aggregates populated DIMMs and ignores empty slots', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.memoryConfig).toEqual({
      totalSizeMb: 128 * 1024,
      populatedDimms: 2,
      totalSlots: 32,
      dimmSizeMb: 64 * 1024,
      dimmType: 'DDR5',
      dimmSpeed: '4800 MT/s',
      configuredSpeed: '4400 MT/s',
      eccType: 'SINGLE_BIT_ECC',
      configSummary: '2x64GB DDR5 4400 MT/s',
    });
  });

  it('reports null dimmSizeMb when slots are mixed size', async () => {
    const parsed = handler.schema.parse([
      { type: 16, values: { number_of_devices: '2', error_correction_type: 'None' } },
      { type: 17, values: { size: '32 GB', type: 'DDR4' } },
      { type: 17, values: { size: '64 GB', type: 'DDR4' } },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.memoryConfig).toMatchObject({
      totalSizeMb: (32 + 64) * 1024,
      populatedDimms: 2,
      dimmSizeMb: null,
      eccType: 'NONE',
    });
  });

  it('tolerates a malformed record mid-list', async () => {
    const parsed = handler.schema.parse([
      { type: 17, values: { size: '16 GB', type: 'DDR4' } },
      null,
      { type: 17, values: { size: '16 GB', type: 'DDR4' } },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.memoryConfig?.populatedDimms).toBe(2);
    expect(mutation.warnings?.[0]).toMatch(/dmidecode_memory\[1\]/);
  });
});
