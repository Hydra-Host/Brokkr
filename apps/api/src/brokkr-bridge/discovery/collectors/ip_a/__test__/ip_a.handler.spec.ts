import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpAHandler } from '../ip_a.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ip_a', `${name}.json`), 'utf8'));

describe('IpAHandler', () => {
  const handler = new IpAHandler();

  it('skips loopback; maps operstate + NO-CARRIER', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    const ifaces = mutation.upserts!.interfaces!;
    expect(ifaces.map((i) => i.name).sort()).toEqual(['enp175s0f0np0', 'enp41s0f0np0']);

    const up = ifaces.find((i) => i.name === 'enp41s0f0np0')!;
    expect(up).toMatchObject({ operstate: 'UP', linkOperUp: true, linkPhysicalUp: true });

    const down = ifaces.find((i) => i.name === 'enp175s0f0np0')!;
    expect(down).toMatchObject({ operstate: 'DOWN', linkOperUp: false, linkPhysicalUp: false });
  });

  it('tolerates missing flags array', async () => {
    const parsed = handler.schema.parse([{ ifname: 'eno1', operstate: 'UP' }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]).toMatchObject({ linkOperUp: true, linkPhysicalUp: true });
  });

  it('warns on malformed row', async () => {
    const parsed = handler.schema.parse([{ operstate: 'UP' }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts).toBeUndefined();
    expect(mutation.warnings?.[0]).toMatch(/ip_a\[0\]/);
  });

  it('skips USB-IPMI virtual NICs (enx<mac>)', async () => {
    const parsed = handler.schema.parse([
      { ifname: 'eno1', operstate: 'UP' },
      { ifname: 'enxa1b2c3d4e5f6', operstate: 'UP' },
      { ifname: 'enxA1B2C3D4E5F6', operstate: 'UP' },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.map((i) => i.name)).toEqual(['eno1']);
  });

  it('stores the udev name from altnames when we renamed the NIC to ethN', async () => {
    const parsed = handler.schema.parse([{ ifname: 'eth0', operstate: 'UP', altnames: ['enp34s0f0'] }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]).toMatchObject({ name: 'enp34s0f0', linkOperUp: true });
  });

  it('keeps a name udev already chose, even when altnames offers another alias', async () => {
    const parsed = handler.schema.parse([{ ifname: 'enp34s0f1', operstate: 'DOWN', altnames: ['ens1f1'] }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]?.name).toBe('enp34s0f1');
  });

  it('keeps ethN when the only altname is a USB-IPMI name', async () => {
    const parsed = handler.schema.parse([{ ifname: 'eth2', operstate: 'UP', altnames: ['enx0ac97ac3f1d2'] }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]?.name).toBe('eth2');
  });

  it('skips a USB-IPMI altname and takes the udev name behind it', async () => {
    const parsed = handler.schema.parse([
      { ifname: 'eth0', operstate: 'UP', altnames: ['enx0ac97ac3f1d2', 'enp34s0f0'] },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]?.name).toBe('enp34s0f0');
  });

  it('skips an empty altname and takes the udev name behind it', async () => {
    const parsed = handler.schema.parse([{ ifname: 'eth0', operstate: 'UP', altnames: ['', 'enp34s0f0'] }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]?.name).toBe('enp34s0f0');
  });

  it('keeps ethN when the NIC reports no altnames', async () => {
    const parsed = handler.schema.parse([{ ifname: 'eth0', operstate: 'UP' }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]?.name).toBe('eth0');
  });

  it('skips bonds and vlans by attribute, keeping the members that are real NICs', async () => {
    const parsed = handler.schema.parse([
      { ifname: 'eno1', operstate: 'UP', master: 'bond0' },
      { ifname: 'eno2', operstate: 'UP', master: 'bond0' },
      { ifname: 'bond0', operstate: 'UP' },
      { ifname: 'bond0.100', operstate: 'UP', link: 'bond0' },
      { ifname: 'mgmt-uplink', operstate: 'UP', link: 'eno3' },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.map((i) => i.name)).toEqual(['eno1', 'eno2']);
    expect(mutation.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/skipped bond\/vlan device\(s\): bond0, bond0\.100, mgmt-uplink/)]),
    );
  });

  it('never writes MACs — ghw_net owns them', async () => {
    const parsed = handler.schema.parse([{ ifname: 'eno1', operstate: 'UP', address: 'aa:bb:cc:dd:ee:01' }]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.interfaces?.[0]).not.toHaveProperty('macAddress');
  });
});
