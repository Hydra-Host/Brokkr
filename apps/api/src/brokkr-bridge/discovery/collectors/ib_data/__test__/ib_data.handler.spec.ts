import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IbDataHandler } from '../ib_data.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ib_data', `${name}.json`), 'utf8'));

describe('IbDataHandler', () => {
  const handler = new IbDataHandler();

  it('emits Interface upserts with linkType mapped per port', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    const ifaces = mutation.upserts!.interfaces!;
    expect(ifaces).toHaveLength(2);
    expect(ifaces[0]).toMatchObject({
      name: 'mlx5_0',
      guid: 'c470:bd03:0033:649a',
      linkType: 'ETHERNET',
      maxSpeedGbps: 400,
      linkOperUp: true,
      linkPhysicalUp: true,
    });
    expect(ifaces[1].linkType).toBe('INFINIBAND');
  });

  it('accepts null max_speed_gbps', async () => {
    const parsed = handler.schema.parse([
      { mlx5_name: 'mlx5_0', guid: 'x', max_speed_gbps: null, link_type: 'Ethernet' },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0].maxSpeedGbps).toBeNull();
  });

  it('warns on malformed row but keeps the rest', async () => {
    const parsed = handler.schema.parse([
      { mlx5_name: 'mlx5_0', guid: 'x' },
      { guid: 'y' },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces).toHaveLength(1);
    expect(mutation.warnings?.[0]).toMatch(/ib_data\[1\]/);
  });
});
