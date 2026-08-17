import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwPciHandler } from '../ghw_pci.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_pci', `${name}.json`), 'utf8'));

describe('GhwPciHandler', () => {
  const handler = new GhwPciHandler();

  it('emits one PciDevice upsert per device with vendor/product normalised', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    const devs = mutation.upserts!.pciDevices!;
    expect(devs).toHaveLength(3);

    const nvidia = devs.find((d) => d.address === '0000:0a:00.0')!;
    expect(nvidia).toMatchObject({
      vendorId: '10de',
      vendorName: 'NVIDIA Corporation',
      productId: '2330',
      productName: 'GH100 [H100 SXM5 80GB]',
      driver: 'nvidia',
      className: 'Display controller',
    });

    const host = devs.find((d) => d.address === '0000:00:00.0')!;
    expect(host.driver).toBeNull();
  });

  it('skips malformed rows and reports a summary warning', async () => {
    const parsed = handler.schema.parse({
      pci: {
        Devices: [
          { address: '0000:00:00.0', vendor: { id: 'x', name: '' }, product: { id: 'y' } },
          null,
          { vendor: { id: 'z' } },
        ],
      },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.pciDevices).toHaveLength(1);
    expect(mutation.warnings?.[0]).toMatch(/2\/3 devices skipped/);
  });

  it('returns undefined upserts when Devices is empty', async () => {
    const parsed = handler.schema.parse({ pci: { Devices: [] } });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts).toBeUndefined();
  });
});
