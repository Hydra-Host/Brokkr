import { describe, expect, it, vi } from 'vitest';
import type { CollectorContext } from '../../collectors/collector.types';
import { NetworkTypeComposer } from '../network-type.composer';

const makeCtx = (rawBundle: Record<string, unknown>): CollectorContext =>
  ({
    runId: 'run-1',
    deviceId: 'dev-1',
    device: { teeEnabled: false } as any,
    rawBundle: rawBundle as any,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  }) as CollectorContext;

describe('NetworkTypeComposer', () => {
  const composer = new NetworkTypeComposer();

  it('classifies Public when public IP appears on a local interface', async () => {
    const ctx = makeCtx({
      public_ip: { ipv4: '198.51.100.42' },
      ip_a: [{ ifname: 'eno1', addr_info: [{ family: 'inet', local: '198.51.100.42', scope: 'global' }] }],
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.deviceUpdate).toEqual({ networkType: 'Public' });
  });

  it('classifies NAT when public IP does not match any local IP', async () => {
    const ctx = makeCtx({
      public_ip: { ipv4: '198.51.100.42' },
      ip_a: [{ ifname: 'eno1', addr_info: [{ family: 'inet', local: '10.0.0.5', scope: 'global' }] }],
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.deviceUpdate).toEqual({ networkType: 'NAT' });
  });

  it('returns empty mutation when public_ip has no ipv4', async () => {
    const ctx = makeCtx({ public_ip: { ipv4: null, ipv6: null }, ip_a: [] });
    const mutation = await composer.compose(ctx);
    expect(mutation).toEqual({});
  });

  it('returns empty mutation when ip_a collector missing', async () => {
    const ctx = makeCtx({ public_ip: { ipv4: '198.51.100.42' } });
    const mutation = await composer.compose(ctx);
    expect(mutation).toEqual({});
  });

  it('ignores loopback interface', async () => {
    const ctx = makeCtx({
      public_ip: { ipv4: '127.0.0.1' },
      ip_a: [
        { ifname: 'lo', link_type: 'loopback', addr_info: [{ family: 'inet', local: '127.0.0.1', scope: 'host' }] },
        { ifname: 'eno1', addr_info: [{ family: 'inet', local: '10.0.0.5', scope: 'global' }] },
      ],
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.deviceUpdate).toEqual({ networkType: 'NAT' });
  });
});
