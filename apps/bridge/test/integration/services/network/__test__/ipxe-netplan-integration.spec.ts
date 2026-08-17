import { describe, expect, it } from 'vitest';

import {
  NetplanToKernelParamsError,
  NetplanToKernelParamsService,
  type ActiveBridgeIpsProvider,
} from '../../../../../src/bridge-network/netplan-to-kernel-params.service';

const HOSTNAME = 'gpu-0001-a1b2c3d4e5';

const STATIC_NETPLAN = `
network:
  ethernets:
    enp35s0f0np0:
      match:
        macaddress: 40:a6:b7:a6:04:8c
      dhcp4: false
      addresses:
        - 10.10.2.48/24
      routes:
        - to: 0.0.0.0/0
          via: 10.10.2.1
          metric: 100
      nameservers:
        addresses:
          - 1.1.1.1
          - 8.8.8.8
      optional: false
  version: 2
`;

const DHCP_NETPLAN = `
network:
  ethernets:
    eth0:
      dhcp4: true
  version: 2
`;

const COMPLEX_BOND_VLAN_NETPLAN = `
network:
  bonds:
    bond0:
      interfaces: [enp1s0, enp2s0]
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        transmit-hash-policy: layer2
        mii-monitor-interval: 100
      addresses: []
  ethernets:
    enp1s0: {}
    enp2s0: {}
  vlans:
    bond0.100:
      id: 100
      link: bond0
      addresses: [192.168.100.10/24]
      routes:
        - to: default
          via: 192.168.100.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
  version: 2
`;

const PUBLIC_IP_SERVER_NETPLAN = `
network:
  ethernets:
    eno2:
      match:
        macaddress: 0c:c4:7a:ab:f6:65
      dhcp4: false
      addresses:
        - 66.226.79.197/24
      routes:
        - to: 0.0.0.0/0
          via: 66.226.79.1
          metric: 100
      nameservers:
        addresses:
          - 1.1.1.1
          - 8.8.8.8
      optional: false
  version: 2
`;

const BONDED_SERVER_NETPLAN = `
network:
  bonds:
    bond0:
      interfaces: [eth0, eth1]
      parameters:
        mode: 802.3ad
        mii-monitor-interval: 100
      addresses:
        - 10.0.0.5/24
      routes:
        - to: 0.0.0.0/0
          via: 10.0.0.1
  ethernets:
    eth0:
      match:
        macaddress: aa:bb:cc:dd:ee:00
    eth1:
      match:
        macaddress: aa:bb:cc:dd:ee:01
  version: 2
`;

const emptyBridgeIps: ActiveBridgeIpsProvider = {
  getActiveBridgeIps: async () => [],
};

function makeService(): NetplanToKernelParamsService {
  return new NetplanToKernelParamsService('test-job-123', emptyBridgeIps);
}

describe('iPXE × netplan kernel-params integration', () => {
  it('converts a static netplan to kernel params including hostname and gateway', async () => {
    const service = makeService();

    const kernelParams = await service.convertNetplanToKernelParams(STATIC_NETPLAN, {
      hostname: HOSTNAME,
    });

    expect(kernelParams.length).toBeGreaterThan(0);
    const ipParam = kernelParams.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain(HOSTNAME);
    expect(ipParam).toContain('10.10.2.48');
    expect(ipParam).toContain('10.10.2.1');
  });

  it('embeds the device hostname in the ip= param', async () => {
    const expectedHostname = 'gpu-0001-a1b2c3d4e5';

    const service = makeService();
    const result = await service.convertNetplanToKernelParams(STATIC_NETPLAN, {
      hostname: expectedHostname,
    });

    const ipParam = result.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain(expectedHostname);
  });

  it('produces template-ready lines containing ifname= and ip=', async () => {
    const service = makeService();
    const kernelNetwork = await service.convertNetplanToKernelParams(STATIC_NETPLAN, {
      hostname: HOSTNAME,
    });

    let templateOutput: string[];
    if (kernelNetwork.length > 0) {
      templateOutput = kernelNetwork.map((line) => `${line} \\`);
      expect(templateOutput.some((line) => line.includes('ifname='))).toBe(true);
      expect(templateOutput.some((line) => line.includes('ip='))).toBe(true);
    } else {
      templateOutput = ['BOOTIF=${netX/mac} \\', 'ip=dhcp \\'];
    }

    expect(templateOutput.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to DHCP template lines when netplan yields no kernel params', async () => {
    const service = makeService();

    const kernelNetwork = await service.convertNetplanToKernelParams(DHCP_NETPLAN, {
      hostname: 'test-host',
    });

    expect(kernelNetwork).toEqual([]);

    const templateOutput =
      kernelNetwork.length > 0 ? kernelNetwork.map((line) => `${line} \\`) : ['BOOTIF=${netX/mac} \\', 'ip=dhcp \\'];

    expect(templateOutput).toEqual(['BOOTIF=${netX/mac} \\', 'ip=dhcp \\']);
  });

  it('emits bond=, vlan=, and ip= for a bond+VLAN topology with ip targeting the VLAN', async () => {
    const service = makeService();

    const kernelParams = await service.convertNetplanToKernelParams(COMPLEX_BOND_VLAN_NETPLAN, {
      hostname: HOSTNAME,
    });

    expect(kernelParams.some((p) => p.startsWith('bond='))).toBe(true);
    expect(kernelParams.some((p) => p.startsWith('vlan='))).toBe(true);
    expect(kernelParams.some((p) => p.startsWith('ip='))).toBe(true);

    const ipParam = kernelParams.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain(':bond0.100:');
    expect(ipParam).toContain('192.168.100.10');
  });

  it('wraps YAML parse failures as NetplanToKernelParamsError', async () => {
    const service = makeService();

    await expect(
      service.convertNetplanToKernelParams('invalid: yaml: [', { hostname: 'test-host' }),
    ).rejects.toMatchObject({
      name: 'NetplanToKernelParamsError',
      message: expect.stringContaining('Failed to convert Netplan to kernel params'),
    });

    await expect(
      service.convertNetplanToKernelParams('invalid: yaml: [', { hostname: 'test-host' }),
    ).rejects.toBeInstanceOf(NetplanToKernelParamsError);
  });

  it('handles real-world public-IP and bonded scenarios', async () => {
    const service = makeService();

    const scenarios: Array<{ name: string; netplan: string }> = [
      { name: 'Public IP Server', netplan: PUBLIC_IP_SERVER_NETPLAN },
      { name: 'Bonded Server', netplan: BONDED_SERVER_NETPLAN },
    ];

    for (const scenario of scenarios) {
      const kernelParams = await service.convertNetplanToKernelParams(scenario.netplan, {
        hostname: HOSTNAME,
      });

      expect(kernelParams.length, `Failed for scenario: ${scenario.name}`).toBeGreaterThan(0);
      const ipParam = kernelParams.find((p) => p.startsWith('ip='));
      expect(ipParam, `No ip parameter for scenario: ${scenario.name}`).toBeDefined();
      expect(ipParam, `Hostname missing for scenario: ${scenario.name}`).toContain(HOSTNAME);
    }

    const bondedParams = await service.convertNetplanToKernelParams(BONDED_SERVER_NETPLAN, {
      hostname: HOSTNAME,
    });
    expect(bondedParams.some((p) => p.startsWith('bond='))).toBe(true);
    const ipParam = bondedParams.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain(':bond0:');
  });
});
