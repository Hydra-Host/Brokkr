import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollectorContext } from '../../collector.types';
import { GhwNetHandler } from '../ghw_net.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_net', `${name}.json`), 'utf8'));

function fakeCtx(rawBundle: CollectorContext['rawBundle']): CollectorContext {
  return {
    runId: 'run-1',
    deviceId: 'device-1',
    device: {} as CollectorContext['device'],
    rawBundle,
    logger: {} as CollectorContext['logger'],
  };
}

describe('GhwNetHandler', () => {
  const handler = new GhwNetHandler();

  it('filters pseudo + virtual NICs, parses Mbps and Gbps speeds', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);

    const ifaces = mutation.upserts!.interfaces!;
    expect(ifaces.map((i) => i.name).sort()).toEqual(['eno1', 'enp175s0f0np0', 'enp41s0f0np0']);

    const by = Object.fromEntries(ifaces.map((i) => [i.name, i]));
    expect(by.eno1).toMatchObject({ speed: 1000, type: 'ETHERNET_1G', macAddress: 'aa:bb:cc:00:00:01' });
    expect(by.enp41s0f0np0).toMatchObject({ speed: 100000, type: 'ETHERNET_100G' });
    expect(by.enp175s0f0np0).toMatchObject({ speed: 400000, type: 'ETHERNET_400G' });
  });

  it('tolerates malformed nic entries', async () => {
    const parsed = handler.schema.parse({ network: { nics: [null, { name: 'eno1', speed: '1000' }] } });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces).toHaveLength(1);
    expect(mutation.warnings?.[0]).toMatch(/ghw_net\.nics\[0\]/);
  });

  it('returns no upserts when every NIC filtered out', async () => {
    const parsed = handler.schema.parse({
      network: { nics: [{ name: 'bonding_masters' }, { name: 'veth0', is_virtual: true }] },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts).toBeUndefined();
  });

  it('adopts the udev name ip_a resolved, so one NIC does not land two rows', async () => {
    const parsed = handler.schema.parse({
      network: { nics: [{ name: 'eth0', mac_address: 'aa:bb:cc:dd:ee:01', speed: '10000' }] },
    });
    const mutation = await handler.handle(parsed, fakeCtx({ ip_a: [{ ifname: 'eth0', altnames: ['enp34s0f0'] }] }));
    expect(mutation.upserts?.interfaces?.[0]).toMatchObject({
      name: 'enp34s0f0',
      speed: 10000,
      macAddress: 'aa:bb:cc:dd:ee:01',
    });
  });

  it('skips USB-IPMI NICs so it agrees with ip_a', async () => {
    const parsed = handler.schema.parse({
      network: {
        nics: [
          { name: 'enx0ac97ac3f1d2', mac_address: '0a:c9:7a:c3:f1:d2' },
          { name: 'enxA1B2C3D4E5F6' },
          { name: 'eno1', speed: '10000' },
        ],
      },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.map((i) => i.name)).toEqual(['eno1']);
  });

  it('prefers permaddr over the sysfs mac a bond rewrote onto its members', async () => {
    const parsed = handler.schema.parse({
      network: {
        nics: [
          { name: 'eno1', mac_address: 'aa:bb:cc:dd:ee:01' },
          { name: 'eno2', mac_address: 'aa:bb:cc:dd:ee:01' },
        ],
      },
    });

    const ctx = fakeCtx({ ip_a: [{ ifname: 'eno2', permaddr: 'AA:BB:CC:DD:EE:02' }] });
    const mutation = await handler.handle(parsed, ctx);

    expect(mutation.upserts?.interfaces?.map((i) => [i.name, i.macAddress])).toEqual([
      ['eno1', 'aa:bb:cc:dd:ee:01'],
      ['eno2', 'aa:bb:cc:dd:ee:02'],
    ]);
  });

  it('omits macAddress rather than nulling a known one when the nic reports none', async () => {
    const parsed = handler.schema.parse({ network: { nics: [{ name: 'eno1', mac_address: '' }] } });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]).not.toHaveProperty('macAddress');
  });
});
