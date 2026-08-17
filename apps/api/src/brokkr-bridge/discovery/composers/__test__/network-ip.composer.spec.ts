import { describe, expect, it, vi } from 'vitest';
import type { CollectorContext } from '../../collectors/collector.types';
import { NetworkIpComposer } from '../network-ip.composer';

const makeCtx = (rawBundle: Record<string, unknown>): CollectorContext =>
  ({
    runId: 'run-1',
    deviceId: 'dev-1',
    device: {} as any,
    rawBundle: rawBundle as any,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  }) as CollectorContext;

const route = (iface: string) => [
  { destination: '0.0.0.0', gateway: '10.0.0.1', genmask: '0.0.0.0', flags: 'UG', metric: 0, iface },
];

describe('NetworkIpComposer', () => {
  const composer = new NetworkIpComposer();

  it('returns empty mutation when ip_a is missing', async () => {
    expect(await composer.compose(makeCtx({ public_ip: { ipv4: '198.51.100.42' } }))).toEqual({});
  });

  it('writes host global addresses as interface IpAddress rows (CIDR-suffixed)', async () => {
    const ctx = makeCtx({
      ip_a: [
        { ifname: 'lo', link_type: 'loopback', addr_info: [{ family: 'inet', local: '127.0.0.1', scope: 'host' }] },
        {
          ifname: 'eno1',
          addr_info: [
            { family: 'inet', local: '10.0.0.5', scope: 'global', prefixlen: 24 },
            { family: 'inet6', local: 'fe80::1', scope: 'link', prefixlen: 64 },
          ],
        },
      ],
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.upserts?.interfaces).toEqual([{ name: 'eno1', ipAddresses: ['10.0.0.5/24'] }]);
    expect(mutation.upserts?.natMappings).toBeUndefined();
  });

  it('emits no NAT mapping when the public IP is directly on a local interface', async () => {
    const ctx = makeCtx({
      public_ip: { ipv4: '198.51.100.42' },
      ip_a: [
        { ifname: 'eno1', addr_info: [{ family: 'inet', local: '198.51.100.42', scope: 'global', prefixlen: 24 }] },
      ],
      route: route('eno1'),
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.upserts?.interfaces).toEqual([{ name: 'eno1', ipAddresses: ['198.51.100.42/24'] }]);
    expect(mutation.upserts?.natMappings).toBeUndefined();
  });

  it('records a NAT mapping (public→private) when the host is behind NAT', async () => {
    const ctx = makeCtx({
      public_ip: { ipv4: '198.51.100.42' },
      ip_a: [{ ifname: 'eno1', addr_info: [{ family: 'inet', local: '10.0.0.5', scope: 'global', prefixlen: 24 }] }],
      route: route('eno1'),
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.upserts?.natMappings).toEqual([{ outsideAddress: '198.51.100.42', insideAddress: '10.0.0.5' }]);
  });

  it('prefers the default-gateway NIC for the NAT inside address', async () => {
    const ctx = makeCtx({
      public_ip: { ipv4: '198.51.100.42' },
      ip_a: [
        { ifname: 'eno1', addr_info: [{ family: 'inet', local: '10.0.0.5', scope: 'global', prefixlen: 24 }] },
        { ifname: 'eno2', addr_info: [{ family: 'inet', local: '10.0.1.9', scope: 'global', prefixlen: 24 }] },
      ],
      route: route('eno2'),
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.upserts?.natMappings).toEqual([{ outsideAddress: '198.51.100.42', insideAddress: '10.0.1.9' }]);
    expect(mutation.upserts?.interfaces?.map((i) => i.name).sort()).toEqual(['eno1', 'eno2']);
  });

  it('maps a NATed public IPv6 to the private global IPv6', async () => {
    const ctx = makeCtx({
      public_ip: { ipv6: '2001:db8:public::1' },
      ip_a: [
        { ifname: 'eno1', addr_info: [{ family: 'inet6', local: '2001:db8:priv::5', scope: 'global', prefixlen: 64 }] },
      ],
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.upserts?.natMappings).toEqual([
      { outsideAddress: '2001:db8:public::1', insideAddress: '2001:db8:priv::5' },
    ]);
  });
});
