import { describe, expect, it, vi } from 'vitest';

import {
  BridgeIpResolutionService,
  serializeInterfaces,
  type BridgeIpResolutionDeps,
  type NetworkInterface,
} from '../bridge-ip-resolution.service';
import { extractStaticAddresses } from '../netplan-extract-addresses';

const PROVISIONING_NETPLAN = `
network:
  version: 2
  ethernets:
    eno1:
      addresses:
        - 10.20.0.50/24
`;

const ROUTED_NETPLAN = `
network:
  version: 2
  ethernets:
    eno1:
      addresses:
        - 192.168.99.5/24
`;

const DHCP_ONLY_NETPLAN = `
network:
  version: 2
  ethernets:
    eno1:
      dhcp4: true
`;

const VLAN_NETPLAN = `
network:
  version: 2
  ethernets:
    eno1: {}
  vlans:
    vlan105:
      id: 105
      link: eno1
      addresses:
        - 10.30.0.7/24
`;

function makeBridgeInterfaces(): NetworkInterface[] {
  return [
    {
      name: 'eth0',
      ip: '10.10.0.1',
      netmask: '255.255.255.0',
      prefix: 24,
      network: '10.10.0.0/24',
      isPrimary: true,
      interfaceType: 'physical',
    },
    {
      name: 'eth1',
      ip: '10.20.0.1',
      netmask: '255.255.255.0',
      prefix: 24,
      network: '10.20.0.0/24',
      isPrimary: false,
      interfaceType: 'physical',
    },
  ];
}

function makeService(interfaces: NetworkInterface[], deps: Partial<BridgeIpResolutionDeps> = {}) {
  return new BridgeIpResolutionService({
    jobId: 'test-job',
    netplanAddressExtractor: {
      extract: (yaml: string) => extractStaticAddresses(yaml).map((a) => a.ip),
    },
    interfaceDiscovery: () => interfaces,
    egressSourceIpFn: async () => null,
    ...deps,
  });
}

describe('BridgeIpResolutionService.getBridgeIpForDevice', () => {
  it('picks the overlapping bridge interface over the primary', async () => {
    const service = makeService(makeBridgeInterfaces());

    expect(await service.getBridgeIpForDevice(PROVISIONING_NETPLAN)).toBe('10.20.0.1');
    expect(await service.resolveBridgeIpForDevice(PROVISIONING_NETPLAN)).toEqual({
      ip: '10.20.0.1',
      authoritative: true,
    });
  });

  it('falls back when no interface overlaps', async () => {
    const service = makeService(makeBridgeInterfaces());

    expect(await service.getBridgeIpForDevice(ROUTED_NETPLAN)).toBe('10.10.0.1');
    expect(await service.resolveBridgeIpForDevice(ROUTED_NETPLAN)).toEqual({
      ip: '10.10.0.1',
      authoritative: false,
    });
  });

  it('falls back when netplan has no static address', async () => {
    const service = makeService(makeBridgeInterfaces());

    expect(await service.getBridgeIpForDevice(DHCP_ONLY_NETPLAN)).toBe('10.10.0.1');
    expect(await service.resolveBridgeIpForDevice(DHCP_ONLY_NETPLAN)).toEqual({
      ip: '10.10.0.1',
      authoritative: false,
    });
  });

  it('picks the overlapping interface for a vlan address', async () => {
    const interfaces: NetworkInterface[] = [
      {
        name: 'eth0',
        ip: '10.10.0.1',
        netmask: '255.255.255.0',
        prefix: 24,
        network: '10.10.0.0/24',
        isPrimary: true,
        interfaceType: 'physical',
      },
      {
        name: 'eth0.105',
        ip: '10.30.0.1',
        netmask: '255.255.255.0',
        prefix: 24,
        network: '10.30.0.0/24',
        isPrimary: false,
        interfaceType: 'other',
      },
    ];
    const service = makeService(interfaces);

    expect(await service.getBridgeIpForDevice(VLAN_NETPLAN)).toBe('10.30.0.1');
    expect(await service.resolveBridgeIpForDevice(VLAN_NETPLAN)).toEqual({ ip: '10.30.0.1', authoritative: true });
  });
});

describe('BridgeIpResolutionService.getBridgeIpForHostsFile — request client IP provider', () => {
  it('resolves to the bridge leg on the client subnet, not the primary interface', async () => {
    const service = makeService(makeBridgeInterfaces(), { requestClientIpProvider: () => '10.20.0.50' });

    expect(await service.getBridgeIpForHostsFile()).toBe('10.20.0.1');
    expect(await service.resolveBridgeIpForDevice(null)).toEqual({ ip: '10.20.0.1', authoritative: true });
  });

  it('falls back to the primary interface when no client IP is available', async () => {
    const service = makeService(makeBridgeInterfaces(), { requestClientIpProvider: () => null });

    expect(await service.getBridgeIpForHostsFile()).toBe('10.10.0.1');
    expect(await service.resolveBridgeIpForDevice(null)).toEqual({ ip: '10.10.0.1', authoritative: false });
  });
});

describe('BridgeIpResolutionService.resolveBridgeIpForDevice — authoritative flag', () => {
  it('is authoritative for a netplan overlap with a live interface', async () => {
    const service = makeService(makeBridgeInterfaces());

    expect(await service.resolveBridgeIpForDevice(PROVISIONING_NETPLAN)).toEqual({
      ip: '10.20.0.1',
      authoritative: true,
    });
  });

  it('is authoritative for direct membership of the request client IP', async () => {
    const service = makeService(makeBridgeInterfaces(), { requestClientIpProvider: () => '10.20.0.77' });

    expect(await service.resolveBridgeIpForDevice(ROUTED_NETPLAN)).toEqual({ ip: '10.20.0.1', authoritative: true });
  });

  it('is authoritative for a route probe whose source is a live interface', async () => {
    const egressSourceIpFn = vi.fn(async () => '10.20.0.1');
    const service = makeService(makeBridgeInterfaces(), {
      requestClientIpProvider: () => '10.9.0.210',
      egressSourceIpFn,
    });

    expect(await service.resolveBridgeIpForDevice(null)).toEqual({ ip: '10.20.0.1', authoritative: true });
    expect(egressSourceIpFn).toHaveBeenCalledWith('10.9.0.210');
  });

  it('is not authoritative when a route probe source is not a live interface', async () => {
    const service = makeService(makeBridgeInterfaces(), {
      requestClientIpProvider: () => '10.9.0.210',
      egressSourceIpFn: async () => '10.2.0.3',
    });

    expect(await service.resolveBridgeIpForDevice(null)).toEqual({ ip: '10.10.0.1', authoritative: false });
  });

  it('is not authoritative for the primary interface fallback', async () => {
    const service = makeService(makeBridgeInterfaces(), { requestClientIpProvider: () => '10.9.0.210' });

    expect(await service.resolveBridgeIpForDevice(ROUTED_NETPLAN)).toEqual({ ip: '10.10.0.1', authoritative: false });
  });

  it('is not authoritative for the zone-wide BRIDGE_URL override', async () => {
    const service = makeService(makeBridgeInterfaces(), {
      appConfig: { bridgeUrl: 'https://10.50.0.9' },
      requestClientIpProvider: () => '10.20.0.77',
    });

    expect(await service.resolveBridgeIpForDevice(null)).toEqual({ ip: '10.50.0.9', authoritative: false });
  });

  it('prefers a netplan overlap with a live interface over the BRIDGE_URL override', async () => {
    const service = makeService(makeBridgeInterfaces(), {
      appConfig: { bridgeUrl: 'https://10.50.0.9' },
      requestClientIpProvider: () => '10.20.0.77',
    });

    expect(await service.resolveBridgeIpForDevice(PROVISIONING_NETPLAN)).toEqual({
      ip: '10.20.0.1',
      authoritative: true,
    });
    expect(await service.getBridgeIpForDevice(PROVISIONING_NETPLAN)).toBe('10.20.0.1');
  });

  it('is not authoritative and yields loopback when interface discovery fails', async () => {
    const service = makeService([], {
      interfaceDiscovery: () => {
        throw new Error('os.networkInterfaces failed');
      },
      requestClientIpProvider: () => '10.20.0.77',
    });

    expect(await service.resolveBridgeIpForDevice(PROVISIONING_NETPLAN)).toEqual({
      ip: '127.0.0.1',
      authoritative: false,
    });
  });

  it('follows live interfaces, not a peer bridge list poisoned into the shared Redis cache', async () => {
    const peerInterfaces: NetworkInterface[] = [
      {
        name: 'eth1',
        ip: '10.20.0.2',
        netmask: '255.255.255.0',
        prefix: 24,
        network: '10.20.0.0/24',
        isPrimary: true,
        interfaceType: 'physical',
      },
    ];
    const cache = {
      get: vi.fn(async () => serializeInterfaces(peerInterfaces)),
      set: vi.fn(async () => undefined),
    };
    const service = makeService(makeBridgeInterfaces(), {
      cache,
      requestClientIpProvider: () => '10.20.0.50',
    });

    expect(await service.resolveBridgeIpForDevice(PROVISIONING_NETPLAN)).toEqual({
      ip: '10.20.0.1',
      authoritative: true,
    });
    expect(await service.resolveBridgeIpForDevice(null)).toEqual({ ip: '10.20.0.1', authoritative: true });
    expect(await service.getBridgeIpForHostsFile()).toBe('10.20.0.1');
    expect(cache.get).not.toHaveBeenCalled();
  });
});
