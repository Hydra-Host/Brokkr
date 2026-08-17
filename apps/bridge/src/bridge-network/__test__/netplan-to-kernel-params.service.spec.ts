import { describe, expect, it } from 'vitest';

import {
  NetplanToKernelParamsError,
  NetplanToKernelParamsService,
  type ActiveBridgeIpsProvider,
} from '../netplan-to-kernel-params.service';

const SIMPLE_STATIC_NETPLAN = `
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
    enp35s0f1np1:
      match:
        macaddress: 40:a6:b7:a6:04:8d
      dhcp4: false
      optional: true
  version: 2
`;

const BOND_VLAN_NETPLAN = `
network:
  bonds:
    bond0:
      interfaces:
      - enp216s0f0np0
      - enp216s0f1np1
      parameters:
        lacp-rate: fast
        mode: 802.3ad
        transmit-hash-policy: layer2
        mii-monitor-interval: 100
  ethernets:
    enp216s0f0np0: {}
    enp216s0f1np1: {}
    enp90s0f0:
      addresses:
      - 10.10.30.12/24
  version: 2
  vlans:
    bond0.105:
      addresses:
      - 205.196.17.35/29
      id: 105
      link: bond0
      nameservers:
        addresses:
        - 1.1.1.1
        - 1.0.0.1
      routes:
      - to: default
        via: 205.196.17.33
`;

const BOND_ONLY_NETPLAN = `
network:
  bonds:
    bond0:
      interfaces:
        - eno768np0
        - ens38f1np1
        - ens96f0np0
        - ens96f1np1
      parameters:
        mode: 802.3ad
        ad-select: stable
        lacp-rate: slow
        min-links: 2
        mii-monitor-interval: 100
        transmit-hash-policy: layer3+4
      dhcp4: false
      addresses:
        - 38.255.28.6/24
      nameservers:
        addresses:
          - 1.1.1.1
          - 8.8.8.8
      macaddress: c4:70:bd:7e:70:64
      routes:
        - to: 0.0.0.0/0
          via: 38.255.28.1
          metric: 100
  ethernets:
    eno768np0:
      match:
        macaddress: c4:70:bd:7e:70:64
    ens38f1np1:
      match:
        macaddress: c4:70:bd:7e:70:65
    ens96f0np0:
      match:
        macaddress: c4:70:bd:7e:6a:98
    ens96f1np1:
      match:
        macaddress: c4:70:bd:7e:6a:99
  version: 2
`;

const DHCP_NETPLAN = `
network:
  ethernets:
    eth0:
      dhcp4: true
    eth1:
      dhcp4: true
  version: 2
`;

function makeService(activeBridgeIps: string[] = []): NetplanToKernelParamsService {
  const provider: ActiveBridgeIpsProvider = {
    getActiveBridgeIps: async () => activeBridgeIps,
  };
  return new NetplanToKernelParamsService('test-job-123', provider);
}

describe('NetplanToKernelParamsService.convertNetplanToKernelParams', () => {
  it('converts a simple static configuration', async () => {
    const service = makeService();
    const hostname = 'host-716-227-133-12345';
    const result = await service.convertNetplanToKernelParams(SIMPLE_STATIC_NETPLAN, { hostname });

    expect(result).toHaveLength(3);
    expect(result).toContain('ifname=enp35s0f0np0:40:a6:b7:a6:04:8c');
    expect(result).toContain('ifname=enp35s0f1np1:40:a6:b7:a6:04:8d');

    const ipParam = result.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain(hostname);
    expect(ipParam).toContain('10.10.2.48');
    expect(ipParam).toContain('10.10.2.1');
    expect(ipParam).toContain('255.255.255.0');
    expect(ipParam).toContain(':enp35s0f0np0:');
  });

  it('converts bond + vlan configuration', async () => {
    const service = makeService();
    const result = await service.convertNetplanToKernelParams(BOND_VLAN_NETPLAN, {
      hostname: 'host-716-227-133-12345',
    });

    const bondParam = result.find((p) => p.startsWith('bond='));
    expect(bondParam).toBeDefined();
    expect(bondParam).toContain('bond0:enp216s0f0np0,enp216s0f1np1');
    expect(bondParam).toContain('mode=802.3ad');
    expect(bondParam).toContain('lacp_rate=fast');
    expect(bondParam).toContain('xmit_hash_policy=layer2');
    expect(bondParam).toContain('miimon=100');

    const vlanParam = result.find((p) => p.startsWith('vlan='));
    expect(vlanParam).toBeDefined();
    expect(vlanParam).toContain('bond0.105:bond0');

    const ipParams = result.filter((p) => p.startsWith('ip='));
    expect(ipParams).toHaveLength(2);

    const vlanIp = ipParams.find((p) => p.includes('205.196.17.35'));
    expect(vlanIp).toBeDefined();
    expect(vlanIp).toContain(':bond0.105:');

    const ethIp = ipParams.find((p) => p.includes('10.10.30.12'));
    expect(ethIp).toBeDefined();
    expect(ethIp).toContain(':enp90s0f0:');
  });

  it('converts a bond with addresses directly on the bond', async () => {
    const service = makeService();
    const result = await service.convertNetplanToKernelParams(BOND_ONLY_NETPLAN, {
      hostname: 'test-host',
    });

    expect(result).toHaveLength(6);

    const ifnameParams = result.filter((p) => p.startsWith('ifname='));
    expect(ifnameParams).toHaveLength(4);
    expect(ifnameParams).toContain('ifname=eno768np0:c4:70:bd:7e:70:64');
    expect(ifnameParams).toContain('ifname=ens38f1np1:c4:70:bd:7e:70:65');
    expect(ifnameParams).toContain('ifname=ens96f0np0:c4:70:bd:7e:6a:98');
    expect(ifnameParams).toContain('ifname=ens96f1np1:c4:70:bd:7e:6a:99');

    const bondParam = result.find((p) => p.startsWith('bond='));
    expect(bondParam).toBeDefined();
    expect(bondParam).toContain('bond0:eno768np0,ens38f1np1,ens96f0np0,ens96f1np1');
    expect(bondParam).toContain('mode=802.3ad');
    expect(bondParam).toContain('lacp_rate=slow');
    expect(bondParam).toContain('xmit_hash_policy=layer3+4');
    expect(bondParam).toContain('miimon=100');
    expect(bondParam).toContain('min_links=2');
    expect(bondParam).toContain('ad_select=stable');

    const ipParam = result.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain(':bond0:');
    expect(ipParam).toContain('38.255.28.6');
    expect(ipParam).toContain('38.255.28.1');
    expect(ipParam).not.toContain(':eno768np0:');
  });

  it('dhcp-only netplan returns an empty list', async () => {
    const service = makeService();
    const result = await service.convertNetplanToKernelParams(DHCP_NETPLAN, {
      hostname: 'host-716-227-133-12345',
    });
    expect(result).toEqual([]);
  });

  it('invalid yaml throws NetplanToKernelParamsError', async () => {
    const service = makeService();
    await expect(service.convertNetplanToKernelParams('invalid: yaml: content: [')).rejects.toBeInstanceOf(
      NetplanToKernelParamsError,
    );
  });

  it('empty netplan throws NetplanToKernelParamsError', async () => {
    const service = makeService();
    await expect(service.convertNetplanToKernelParams('', { hostname: 'test-host' })).rejects.toBeInstanceOf(
      NetplanToKernelParamsError,
    );
  });

  it('default hostname is empty', async () => {
    const service = makeService();
    const result = await service.convertNetplanToKernelParams(SIMPLE_STATIC_NETPLAN);
    const ipParam = result.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    const parts = ipParam!.split(':');
    expect(parts[4]).toBe('');
  });

  it('bridge_ip is used as nameserver when provided', async () => {
    const service = makeService();
    const result = await service.convertNetplanToKernelParams(SIMPLE_STATIC_NETPLAN, {
      hostname: 'test',
      bridgeIp: '10.0.0.1',
    });
    const ipParam = result.find((p) => p.startsWith('ip='));
    expect(ipParam).toBeDefined();
    expect(ipParam).toContain('10.0.0.1');
    expect(ipParam).not.toContain('1.1.1.1');
    expect(ipParam).not.toContain('8.8.8.8');
  });

  it('parameters are ordered: ifname, bond, vlan, ip', async () => {
    const service = makeService();
    const result = await service.convertNetplanToKernelParams(BOND_VLAN_NETPLAN, {
      hostname: 'test-host',
    });

    const firstBondIdx = result.findIndex((p) => p.startsWith('bond='));
    const firstVlanIdx = result.findIndex((p) => p.startsWith('vlan='));
    const firstIpIdx = result.findIndex((p) => p.startsWith('ip='));

    expect(firstBondIdx).toBeGreaterThanOrEqual(0);
    expect(firstVlanIdx).toBeGreaterThanOrEqual(0);
    expect(firstIpIdx).toBeGreaterThanOrEqual(0);
    expect(firstBondIdx).toBeLessThan(firstVlanIdx);
    expect(firstVlanIdx).toBeLessThan(firstIpIdx);
  });

  it('ip= params with gateway in same subnet as bridge are placed last', async () => {
    const netplan = `
network:
  ethernets:
    eth0:
      addresses: [10.0.0.5/24]
      dhcp4: false
      routes:
        - to: 0.0.0.0/0
          via: 10.0.0.1
    eth1:
      addresses: [192.168.1.5/24]
      dhcp4: false
  version: 2
`;
    const service = makeService(['10.0.0.100']);
    const result = await service.convertNetplanToKernelParams(netplan, { hostname: 'test' });
    const ipParams = result.filter((p) => p.startsWith('ip='));
    expect(ipParams).toHaveLength(2);
    expect(ipParams[0]).toContain('192.168.1.5');
    expect(ipParams[1]).toContain('10.0.0.5');
  });

  it('multi-homed device with multiple bridge ips orders bridge-reachable interface last', async () => {
    const netplan = `
network:
  ethernets:
    eth0:
      addresses: [172.16.0.5/24]
      dhcp4: false
      routes:
        - to: 0.0.0.0/0
          via: 172.16.0.1
    eth1:
      addresses: [10.0.0.5/24]
      dhcp4: false
      routes:
        - to: 0.0.0.0/0
          via: 10.0.0.254
    eth2:
      addresses: [192.168.1.5/24]
      dhcp4: false
      routes:
        - to: 0.0.0.0/0
          via: 192.168.1.254
  version: 2
`;
    const service = makeService(['10.0.0.1', '192.168.1.1']);
    const result = await service.convertNetplanToKernelParams(netplan, { hostname: 'test' });
    const ipParams = result.filter((p) => p.startsWith('ip='));
    expect(ipParams).toHaveLength(3);
    expect(ipParams[0]).toContain('172.16.0.5');
    const tail = ipParams.slice(1);
    expect(tail.some((p) => p.includes('10.0.0.5'))).toBe(true);
    expect(tail.some((p) => p.includes('192.168.1.5'))).toBe(true);
  });
});

describe('NetplanToKernelParamsService.convertNetplanDictToKernelParams', () => {
  it('generates a bond= line with mapped options', () => {
    const service = new NetplanToKernelParamsService();
    const networkConfig = {
      bonds: {
        bond0: {
          interfaces: ['eth0', 'eth1'],
          parameters: {
            mode: '802.3ad',
            'lacp-rate': 'fast',
            'mii-monitor-interval': 100,
          },
        },
      },
    };
    const result = service.convertNetplanDictToKernelParams(networkConfig, '', '', []);
    expect(result).toContain('bond=bond0:eth0,eth1:mode=802.3ad,lacp_rate=fast,miimon=100');
  });

  it('generates a bond= line without options when none provided', () => {
    const service = new NetplanToKernelParamsService();
    const networkConfig = { bonds: { bond0: { interfaces: ['eth0', 'eth1'] } } };
    const result = service.convertNetplanDictToKernelParams(networkConfig, '', '', []);
    expect(result).toContain('bond=bond0:eth0,eth1');
  });

  it('generates a vlan= line', () => {
    const service = new NetplanToKernelParamsService();
    const networkConfig = { vlans: { 'bond0.100': { link: 'bond0', id: 100 } } };
    const result = service.convertNetplanDictToKernelParams(networkConfig, '', '', []);
    expect(result).toContain('vlan=bond0.100:bond0');
  });

  it('skips vlan without a link', () => {
    const service = new NetplanToKernelParamsService();
    const networkConfig = { vlans: { vlan100: { id: 100 } } };
    const result = service.convertNetplanDictToKernelParams(networkConfig, '', '', []);
    expect(result.some((p) => p.startsWith('vlan='))).toBe(false);
  });

  it('generates an ifname= line for ethernets with a match macaddress', () => {
    const service = new NetplanToKernelParamsService();
    const networkConfig = {
      ethernets: {
        eth0: { match: { macaddress: 'aa:bb:cc:dd:ee:ff' } },
        eth1: {},
      },
    };
    const result = service.convertNetplanDictToKernelParams(networkConfig, '', '', []);
    const ifnameLines = result.filter((p) => p.startsWith('ifname='));
    expect(ifnameLines).toEqual(['ifname=eth0:aa:bb:cc:dd:ee:ff']);
  });
});
