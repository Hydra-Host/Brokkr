import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwBiosHandler } from '../ghw_bios.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_bios', `${name}.json`), 'utf8'));

describe('GhwBiosHandler', () => {
  const handler = new GhwBiosHandler();

  it('upserts a BIOS firmware row with vendor/version/date', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.firmwares).toEqual([
      {
        type: 'BIOS',
        vendor: 'American Megatrends International, LLC.',
        version: 'P3.50',
        date: '10/27/2022',
      },
    ]);
  });

  it('normalises vendor garbage to null via hardwareString', () => {
    const parsed = handler.schema.parse({
      bios: { vendor: 'To Be Filled By O.E.M.', version: '1.0', date: '  ' },
    });
    expect(parsed.bios.vendor).toBeNull();
    expect(parsed.bios.date).toBeNull();
  });

  it('rejects when version is missing', () => {
    expect(handler.schema.safeParse({ bios: { vendor: 'x', date: '2024' } }).success).toBe(false);
  });
});
