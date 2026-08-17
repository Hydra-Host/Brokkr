import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwChassisHandler } from '../ghw_chassis.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_chassis', `${name}.json`), 'utf8'));

describe('GhwChassisHandler', () => {
  const handler = new GhwChassisHandler();

  it('writes chassisSerial; normalises placeholder asset_tag to null', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toEqual({
      chassisSerial: 'J52S574',
      assetTag: null,
    });
  });

  it('keeps real asset tags', async () => {
    const parsed = handler.schema.parse({
      chassis: {
        asset_tag: 'DC-42',
        serial_number: 'SN-1',
        vendor: 'Dell',
        version: 'A1',
        type: '23',
        type_description: 'Rack',
      },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate?.assetTag).toBe('DC-42');
    expect(mutation.deviceUpdate?.chassisSerial).toBe('SN-1');
  });
});
