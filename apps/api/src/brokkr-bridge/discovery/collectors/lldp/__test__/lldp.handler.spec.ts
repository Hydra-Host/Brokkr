import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LldpHandler } from '../lldp.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/lldp', `${name}.json`), 'utf8'));

describe('LldpHandler', () => {
  const handler = new LldpHandler();

  it('parses array form (many neighbors) and extracts chassis name + port id + mgmt ip', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    const ifaces = mutation.upserts!.interfaces!;
    expect(ifaces).toHaveLength(2);
    expect(ifaces[0]).toEqual({
      name: 'ens11f0np0',
      lldpNeighborName: 'JP01-1-P1-TAN-LEAF-1',
      lldpNeighborDescr: 'Cumulus Linux version 5.12.0 running on Nvidia SN5600',
      lldpNeighborMgmtIp: '10.0.0.253',
      lldpNeighborPort: 'swp9s3',
    });
  });

  it('parses single form (one neighbor as a bare object)', async () => {
    const parsed = handler.schema.parse(fixture('single'));
    const mutation = await handler.handle(parsed);
    const ifaces = mutation.upserts!.interfaces!;
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0]).toMatchObject({
      name: 'enp129s0f0',
      lldpNeighborName: 'switch-01',
      lldpNeighborMgmtIp: '10.0.0.1',
      lldpNeighborPort: 'Ethernet1',
    });
  });

  it('returns empty mutation when no LLDP neighbors', async () => {
    const parsed = handler.schema.parse({ lldp: {} });
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });
});
