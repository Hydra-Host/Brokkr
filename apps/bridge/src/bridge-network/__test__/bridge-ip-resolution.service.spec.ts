import { describe, expect, it, vi } from 'vitest';

import { BridgeIpResolutionService, type NetworkInterface } from '../bridge-ip-resolution.service';
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

function makeService(interfaces: NetworkInterface[]) {
  const service = new BridgeIpResolutionService({
    jobId: 'test-job',
    netplanAddressExtractor: {
      extract: (yaml: string) => extractStaticAddresses(yaml).map((a) => a.ip),
    },
  });
  (service as unknown as { getBridgeInterfaces: () => Promise<NetworkInterface[]> }).getBridgeInterfaces = async () =>
    interfaces;
  return service;
}

describe('BridgeIpResolutionService.getBridgeIpForDevice', () => {
  it('picks the overlapping bridge interface over the primary', async () => {
    const service = makeService(makeBridgeInterfaces());
    const fallback = vi.fn(async () => '10.10.0.1');
    service.getBridgeIpForHostsFile = fallback;

    const result = await service.getBridgeIpForDevice(PROVISIONING_NETPLAN);

    expect(result).toBe('10.20.0.1');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back when no interface overlaps', async () => {
    const service = makeService(makeBridgeInterfaces());
    const fallback = vi.fn(async () => '10.10.0.1');
    service.getBridgeIpForHostsFile = fallback;

    const result = await service.getBridgeIpForDevice(ROUTED_NETPLAN);

    expect(result).toBe('10.10.0.1');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when netplan has no static address', async () => {
    const interfaces = makeBridgeInterfaces();
    const service = makeService(interfaces);
    const fallback = vi.fn(async () => '10.10.0.1');
    const getInterfaces = vi.fn(async () => interfaces);
    (service as unknown as { getBridgeInterfaces: () => Promise<NetworkInterface[]> }).getBridgeInterfaces =
      getInterfaces;
    service.getBridgeIpForHostsFile = fallback;

    const result = await service.getBridgeIpForDevice(DHCP_ONLY_NETPLAN);

    expect(result).toBe('10.10.0.1');
    expect(getInterfaces).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
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
    service.getBridgeIpForHostsFile = vi.fn(async () => '10.10.0.1');

    const result = await service.getBridgeIpForDevice(VLAN_NETPLAN);

    expect(result).toBe('10.30.0.1');
  });
});

describe('BridgeIpResolutionService.getBridgeIpForHostsFile — request client IP provider', () => {
  function makeServiceWithProvider(provider: () => string | null, interfaces: NetworkInterface[]) {
    const service = new BridgeIpResolutionService({
      jobId: 'test-job',
      netplanAddressExtractor: { extract: (yaml: string) => extractStaticAddresses(yaml).map((a) => a.ip) },
      requestClientIpProvider: provider,
    });
    (service as unknown as { getBridgeInterfaces: () => Promise<NetworkInterface[]> }).getBridgeInterfaces = async () =>
      interfaces;
    return service;
  }

  it('resolves to the bridge leg on the client subnet, not the primary interface', async () => {
    const service = makeServiceWithProvider(() => '10.20.0.50', makeBridgeInterfaces());

    expect(await service.getBridgeIpForHostsFile()).toBe('10.20.0.1');
  });

  it('falls back to the primary interface when no client IP is available', async () => {
    const service = makeServiceWithProvider(() => null, makeBridgeInterfaces());

    expect(await service.getBridgeIpForHostsFile()).toBe('10.10.0.1');
  });
});
