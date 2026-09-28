import { describe, expect, it, vi } from 'vitest';

import type { NetworkInterface } from '../bridge-ip-resolution.service';
import { PEER_ANCHOR_TTL_MS, PeerAnchorResolver, stripV4MappedPrefix } from '../peer-anchor-resolver';

function iface(name: string, ip: string, network: string, isPrimary = false): NetworkInterface {
  const prefix = Number(network.split('/')[1]);
  return { name, ip, netmask: '', prefix, network, isPrimary, interfaceType: 'physical' };
}

const SITE_3427_INTERFACES: NetworkInterface[] = [
  iface('eno8303', '192.168.105.33', '192.168.105.0/24', true),
  iface('wt0', '100.125.151.144', '100.125.0.0/16'),
  iface('eth3', '10.2.0.2', '10.2.0.0/16'),
  iface('eth4', '10.100.0.1', '10.100.0.0/16'),
];

function makeResolver(
  overrides: {
    interfaces?: NetworkInterface[];
    egress?: (target: string) => Promise<string | null>;
    now?: () => number;
  } = {},
) {
  const interfaceDiscovery = vi.fn(() => overrides.interfaces ?? SITE_3427_INTERFACES);
  const egressSourceIpFn = vi.fn(overrides.egress ?? (async (): Promise<string | null> => '10.2.0.2'));
  const resolver = new PeerAnchorResolver({ interfaceDiscovery, egressSourceIpFn, now: overrides.now });
  return { resolver, interfaceDiscovery, egressSourceIpFn };
}

describe('PeerAnchorResolver.resolve', () => {
  it('anchors a routed peer on the probe source when it is a live interface', async () => {
    const { resolver, egressSourceIpFn } = makeResolver();

    expect(await resolver.resolve('10.9.0.210')).toBe('10.2.0.2');
    expect(egressSourceIpFn).toHaveBeenCalledWith('10.9.0.210');
  });

  it('strips the v4-mapped prefix before probing', async () => {
    const { resolver, egressSourceIpFn } = makeResolver();

    expect(await resolver.resolve('::ffff:10.9.0.210')).toBe('10.2.0.2');
    expect(egressSourceIpFn).toHaveBeenCalledWith('10.9.0.210');
  });

  it('anchors on the client-facing interface whose subnet holds the peer without probing', async () => {
    const { resolver, egressSourceIpFn } = makeResolver();

    expect(await resolver.resolve('10.100.7.7')).toBe('10.100.0.1');
    expect(egressSourceIpFn).not.toHaveBeenCalled();
  });

  it('never falls back to the primary interface when direct and route both miss', async () => {
    const { resolver } = makeResolver({ egress: async () => null });

    expect(await resolver.resolve('10.9.0.210')).toBeNull();
  });

  it('does not treat a peer inside a non-client-facing interface subnet as a direct match', async () => {
    const { resolver, egressSourceIpFn } = makeResolver({ egress: async () => null });

    expect(await resolver.resolve('100.125.9.9')).toBeNull();
    expect(egressSourceIpFn).toHaveBeenCalledWith('100.125.9.9');
  });

  it('rejects a probe source that is not one of the live interfaces', async () => {
    const { resolver } = makeResolver({ egress: async () => '10.2.0.3' });

    expect(await resolver.resolve('10.9.0.210')).toBeNull();
  });

  it('returns null without throwing when the probe throws', async () => {
    const { resolver } = makeResolver({
      egress: async () => {
        throw new Error('socket exploded');
      },
    });

    await expect(resolver.resolve('10.9.0.210')).resolves.toBeNull();
  });

  it('returns null without throwing when interface discovery throws', async () => {
    const resolver = new PeerAnchorResolver({
      interfaceDiscovery: () => {
        throw new Error('os.networkInterfaces failed');
      },
      egressSourceIpFn: async () => '10.2.0.2',
    });

    await expect(resolver.resolve('10.9.0.210')).resolves.toBeNull();
  });

  it('never anchors on loopback', async () => {
    const { resolver } = makeResolver({
      interfaces: [iface('lo', '127.0.0.1', '127.0.0.0/8')],
      egress: async () => '127.0.0.1',
    });

    expect(await resolver.resolve('10.9.0.210')).toBeNull();
  });

  it('returns null for a non-IPv4 peer', async () => {
    const { resolver, egressSourceIpFn } = makeResolver();

    expect(await resolver.resolve('fd00::5')).toBeNull();
    expect(egressSourceIpFn).not.toHaveBeenCalled();
  });
});

describe('PeerAnchorResolver cache', () => {
  it('serves a hit within the TTL without probing again', async () => {
    let now = 1_000;
    const { resolver, egressSourceIpFn } = makeResolver({ now: () => now });

    await resolver.resolve('10.9.0.210');
    now += PEER_ANCHOR_TTL_MS - 1;
    expect(await resolver.resolve('10.9.0.210')).toBe('10.2.0.2');

    expect(egressSourceIpFn).toHaveBeenCalledTimes(1);
  });

  it('probes again once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const { resolver, egressSourceIpFn } = makeResolver();

      await resolver.resolve('10.9.0.210');
      vi.advanceTimersByTime(PEER_ANCHOR_TTL_MS);
      await resolver.resolve('10.9.0.210');

      expect(egressSourceIpFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a null result', async () => {
    const egress = vi.fn<(target: string) => Promise<string | null>>().mockResolvedValueOnce(null);
    egress.mockResolvedValue('10.2.0.2');
    const { resolver, egressSourceIpFn } = makeResolver({ egress });

    expect(await resolver.resolve('10.9.0.210')).toBeNull();
    expect(await resolver.resolve('10.9.0.210')).toBe('10.2.0.2');

    expect(egressSourceIpFn).toHaveBeenCalledTimes(2);
  });

  it('shares one cache entry between the plain and v4-mapped forms of a peer', async () => {
    const { resolver, egressSourceIpFn } = makeResolver();

    await resolver.resolve('10.9.0.210');
    await resolver.resolve('::ffff:10.9.0.210');

    expect(egressSourceIpFn).toHaveBeenCalledTimes(1);
  });
});

describe('stripV4MappedPrefix', () => {
  it('strips only a v4-mapped prefix wrapping a valid IPv4 address', () => {
    expect(stripV4MappedPrefix('::ffff:10.9.0.210')).toBe('10.9.0.210');
    expect(stripV4MappedPrefix('::FFFF:10.9.0.210')).toBe('10.9.0.210');
    expect(stripV4MappedPrefix('10.9.0.210')).toBe('10.9.0.210');
    expect(stripV4MappedPrefix('::ffff:abcd')).toBe('::ffff:abcd');
  });
});
