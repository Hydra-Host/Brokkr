import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwProductHandler } from '../ghw_product.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_product', `${name}.json`), 'utf8'));

describe('GhwProductHandler', () => {
  const handler = new GhwProductHandler();

  it('normalises OEM-placeholder strings to null and keeps the UUID', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toEqual({
      systemUuid: '59184cd9-2c52-4aa9-ba33-000000000000',
      serial: null,
      productSku: null,
    });
  });

  it('keeps real vendor strings', () => {
    const parsed = handler.schema.parse({
      product: {
        family: 'PowerEdge',
        name: 'R750',
        vendor: 'Dell Inc.',
        serial_number: 'ABC123',
        uuid: '59184cd9-2c52-4aa9-ba33-000000000001',
        sku: '755258-B21',
        version: 'A01',
      },
    });
    expect(parsed.product.vendor).toBe('Dell Inc.');
    expect(parsed.product.serial_number).toBe('ABC123');
    expect(parsed.product.sku).toBe('755258-B21');
  });

  it('rejects a malformed uuid (keeps sane identity)', () => {
    const out = handler.schema.safeParse({ product: { uuid: 'not-a-uuid' } });
    expect(out.success).toBe(false);
  });

  it('accepts missing uuid (some BIOSes omit it)', () => {
    const out = handler.schema.safeParse({ product: {} });
    expect(out.success).toBe(true);
  });
});
