import { describe, expect, it } from 'vitest';
import type { CollectorContext } from '../../collectors/collector.types';
import { IpmiInterfaceComposer, isBlankBmcIp } from '../ipmi-interface.composer';

const makeCtx = (bundle: Record<string, unknown>): CollectorContext => ({ rawBundle: bundle }) as CollectorContext;

describe('IpmiInterfaceComposer', () => {
  const composer = new IpmiInterfaceComposer();

  it('emits an IPMI_BMC Interface upsert with upper-cased MAC', async () => {
    const mutation = await composer.compose(makeCtx({ bmc: { mac: 'aa:bb:cc:dd:ee:ff', ipv4: '10.0.0.1/24' } }));
    expect(mutation.upserts?.interfaces).toHaveLength(1);
    const iface = mutation.upserts!.interfaces![0]!;
    expect(iface).toMatchObject({
      name: 'IPMI',
      type: 'IPMI_BMC',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      mgmtOnly: true,
      enabled: true,
    });
  });

  it('emits nothing when bmc collector is absent', async () => {
    const mutation = await composer.compose(makeCtx({}));
    expect(mutation).toEqual({});
  });

  it('treats 00:00:00:00:00:00 as blank and emits nothing', async () => {
    const mutation = await composer.compose(makeCtx({ bmc: { mac: '00:00:00:00:00:00', ipv4: null } }));
    expect(mutation).toEqual({});
  });

  it('still emits when MAC is present but both IPs are blank — MAC alone identifies the NIC', async () => {
    const mutation = await composer.compose(makeCtx({ bmc: { mac: 'aa:bb:cc:dd:ee:ff', ipv4: null, ipv6: null } }));
    expect(mutation.upserts?.interfaces).toHaveLength(1);
    expect(mutation.upserts!.interfaces![0]!.ipAddresses).toBeUndefined();
  });

  it('attaches the BMC LAN addresses as IpAddress upserts', async () => {
    const mutation = await composer.compose(
      makeCtx({ bmc: { mac: 'aa:bb:cc:dd:ee:ff', ipv4: '10.20.2.42/24', ipv6: '2001:db8::42' } }),
    );
    expect(mutation.upserts!.interfaces![0]!.ipAddresses).toEqual(['10.20.2.42/24', '2001:db8::42']);
  });

  it('drops blank/zero IPs from the IpAddress upserts', async () => {
    const mutation = await composer.compose(makeCtx({ bmc: { mac: 'aa:bb:cc:dd:ee:ff', ipv4: '0.0.0.0', ipv6: '::/64' } }));
    expect(mutation.upserts!.interfaces![0]!.ipAddresses).toBeUndefined();
  });
});

describe('isBlankBmcIp', () => {
  it.each(['', '0.0.0.0', '0.0.0.0/0', '::', '::/64', '::/48', null])('%s → true', (ip) => {
    expect(isBlankBmcIp(ip)).toBe(true);
  });

  it.each(['10.0.0.1', '10.0.0.1/24', '2001:db8::1'])('%s → false', (ip) => {
    expect(isBlankBmcIp(ip)).toBe(false);
  });
});
