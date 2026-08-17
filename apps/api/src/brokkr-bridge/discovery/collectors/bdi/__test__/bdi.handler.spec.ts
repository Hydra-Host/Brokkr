import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BdiHandler } from '../bdi.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/bdi', `${name}.json`), 'utf8'));

describe('BdiHandler', () => {
  const handler = new BdiHandler();

  it('parses happy fixture and returns empty mutation', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('rejects input when station_mac is missing', () => {
    const out = handler.schema.safeParse({ station_ip: '10.0.0.10' });
    expect(out.success).toBe(false);
  });

  it('tolerates unknown sibling fields (bridge may add new ones)', () => {
    const out = handler.schema.safeParse({ station_mac: '02:00:00:00:00:01', future_field: 42 });
    expect(out.success).toBe(true);
  });
});
