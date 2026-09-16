import { describe, expect, it } from 'vitest';

import {
  DHCPACK,
  DHCPDISCOVER,
  DHCPNAK,
  DHCPOFFER,
  DHCPREQUEST,
  OPT_CLIENT_ARCH,
  OPT_DNS_SERVERS,
  OPT_REQUESTED_IP,
  OPT_SERVER_ID,
  decodeIp,
  encodeIp,
} from '../dhcp-options.js';
import { DhcpEngine, type IngressInfo } from '../dhcp-server.js';
import type { LeaseRecord } from '../lease-store/lease-record.js';
import type { LeaseStore } from '../lease-store/lease-store.js';
import { type DhcpMessage, parsePacket } from '../protocol.js';
import type { SubnetConfig } from '../subnet.js';
import { request } from './test-factories.js';

const SERVER_ID = '10.0.0.1';

function makeSubnetConfig(overrides: Partial<SubnetConfig> = {}): SubnetConfig {
  return {
    subnetMask: '255.255.255.0',
    rangeStart: '10.0.0.10',
    rangeEnd: '10.0.0.12',
    reservations: [],
    excludeIps: [],
    routers: ['10.0.0.1'],
    dnsServers: ['10.0.0.1'],
    leaseTtlSeconds: 3600,
    declineBackoffSeconds: 600,
    tftpServer: '',
    bootfile: '',
    bootfileByArch: new Map(),
    bootBootfile: '',
    bootServerName: '',
    bootServerAddress: '',
    dhcpOptions: [],
    dnsSelf: false,
    serverId: SERVER_ID,
    ...overrides,
  };
}

function reparseReply(reply: Buffer): DhcpMessage {
  const copy = Buffer.from(reply);
  copy[0] = 1;
  return parsePacket(copy);
}

function decodeReply(reply: Buffer): { messageType: number; yiaddr: string; options: Map<number, Buffer> } {
  const parsed = reparseReply(reply);
  return { messageType: parsed.messageType!, yiaddr: parsed.yiaddr, options: parsed.options };
}

const SUBNET_A = makeSubnetConfig({
  subnetMask: '255.255.255.0',
  rangeStart: '10.0.0.10',
  rangeEnd: '10.0.0.12',
  routers: ['10.0.0.1'],
  serverId: '10.0.0.1',
});

const SUBNET_B = makeSubnetConfig({
  subnetMask: '255.255.255.0',
  rangeStart: '10.0.1.10',
  rangeEnd: '10.0.1.12',
  routers: ['10.0.1.1'],
  serverId: '10.0.1.1',
});

const ETH0_INGRESS: IngressInfo = { ifindex: 2, ifname: 'eth0' };
const ETH1_INGRESS: IngressInfo = { ifindex: 3, ifname: 'eth1' };

describe('Multi-subnet selectSubnet', () => {
  it('selects a subnet without a relay selector by giaddr CIDR', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const subnet = engine.selectSubnet(request(DHCPDISCOVER, { giaddr: '10.0.1.50' }), ETH0_INGRESS);
    expect(subnet).not.toBeNull();
    expect(subnet!.containsIp('10.0.1.10')).toBe(true);
    expect(subnet!.containsIp('10.0.0.10')).toBe(false);
  });

  it('selects a subnet by its configured relay agent IP outside the subnet CIDR', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [],
      relayed: [makeSubnetConfig({ ...SUBNET_B, relayAgentIp: '172.16.0.1' })],
    });

    const subnet = engine.selectSubnet(request(DHCPDISCOVER, { giaddr: '172.16.0.1' }), ETH0_INGRESS);
    expect(subnet).not.toBeNull();
    expect(subnet!.containsIp('10.0.1.10')).toBe(true);
  });

  it('does not select a configured relayed subnet for a different relay agent', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [],
      relayed: [makeSubnetConfig({ ...SUBNET_B, relayAgentIp: '172.16.0.1' })],
    });

    const subnet = engine.selectSubnet(request(DHCPDISCOVER, { giaddr: '10.0.1.50' }), ETH0_INGRESS);
    expect(subnet).toBeNull();
  });

  it('selects subnet by ciaddr (RENEW/REBIND)', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const subnet = engine.selectSubnet(request(DHCPREQUEST, { ciaddr: '10.0.0.11' }), ETH0_INGRESS);
    expect(subnet).not.toBeNull();
    expect(subnet!.containsIp('10.0.0.10')).toBe(true);
  });

  it('selects subnet by requested-IP option', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const subnet = engine.selectSubnet(
      request(DHCPREQUEST, {
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.1.11')]]),
      }),
      ETH0_INGRESS,
    );
    expect(subnet).not.toBeNull();
    expect(subnet!.containsIp('10.0.1.10')).toBe(true);
  });

  it('returns null when the IP matches no subnet', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
    });
    const subnet = engine.selectSubnet(request(DHCPREQUEST, { ciaddr: '192.168.99.1' }), ETH0_INGRESS);
    expect(subnet).toBeNull();
  });

  it('group-allocates by ingress interface for a bare broadcast DISCOVER', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        { interfaceKey: 'eth0', subnets: [SUBNET_A] },
        { interfaceKey: 'eth1', subnets: [SUBNET_B] },
      ],
    });
    const subA = engine.selectSubnet(request(DHCPDISCOVER), ETH0_INGRESS);
    expect(subA).not.toBeNull();
    expect(subA!.containsIp('10.0.0.10')).toBe(true);

    const subB = engine.selectSubnet(request(DHCPDISCOVER), ETH1_INGRESS);
    expect(subB).not.toBeNull();
    expect(subB!.containsIp('10.0.1.10')).toBe(true);
  });

  it('dispatches a DISCOVER by the selected subnet mode, not the engine fallback', () => {
    const proxySubnet = makeSubnetConfig({
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.12',
      routers: ['10.0.0.1'],
      serverId: '10.0.0.1',
      mode: 'PROXY',
    });
    const authSubnet = makeSubnetConfig({
      rangeStart: '10.0.1.10',
      rangeEnd: '10.0.1.12',
      routers: ['10.0.1.1'],
      serverId: '10.0.1.1',
      mode: 'AUTHORITATIVE',
    });
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        { interfaceKey: 'eth0', subnets: [proxySubnet] },
        { interfaceKey: 'eth1', subnets: [authSubnet] },
      ],
    });

    const proxyReply = engine.handle(
      request(DHCPDISCOVER, { chaddr: '00:0b:82:01:fc:10' }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(proxyReply).toBeNull();

    const authReply = engine.handle(
      request(DHCPDISCOVER, { chaddr: '00:0b:82:01:fc:11' }),
      SERVER_ID,
      false,
      ETH1_INGRESS,
    );
    expect(authReply).not.toBeNull();
    expect(decodeReply(authReply!.reply).yiaddr).toBe('10.0.1.10');
  });

  it('builds a PROXY PXE reply from the ingress-selected subnet, not the first subnet', () => {
    const proxyA = makeSubnetConfig({
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.12',
      routers: ['10.0.0.1'],
      serverId: '10.0.0.1',
      mode: 'PROXY',
      tftpServer: '10.0.0.99',
    });
    const proxyB = makeSubnetConfig({
      rangeStart: '10.0.1.10',
      rangeEnd: '10.0.1.12',
      routers: ['10.0.1.1'],
      serverId: '10.0.1.1',
      mode: 'PROXY',
      tftpServer: '10.0.1.99',
    });
    const engine = DhcpEngine.fromSubnets({
      mode: 'PROXY',
      networks: [
        { interfaceKey: 'eth0', subnets: [proxyA] },
        { interfaceKey: 'eth1', subnets: [proxyB] },
      ],
    });

    const pxeDiscover = request(DHCPDISCOVER, {
      chaddr: '00:0b:82:01:fc:20',
      options: new Map([[OPT_CLIENT_ARCH, Buffer.from([0, 7])]]),
    });
    const reply = engine.handle(pxeDiscover, SERVER_ID, false, ETH1_INGRESS);
    expect(reply).not.toBeNull();
    expect(reparseReply(reply!.reply).siaddr).toBe('10.0.1.99');
  });
});

describe('Multi-subnet shared-network group allocation', () => {
  it('prefers the subnet where the MAC already holds a lease', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const mac = '00:0b:82:01:fc:42';

    const offer1 = engine.handle(
      request(DHCPDISCOVER, {
        chaddr: mac,
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.1.10')]]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(offer1).not.toBeNull();
    expect(decodeReply(offer1!.reply).yiaddr).toBe('10.0.1.10');

    engine.handle(
      request(DHCPREQUEST, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.1.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    const offer2 = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer2).not.toBeNull();
    const yiaddr = decodeReply(offer2!.reply).yiaddr;
    expect(yiaddr).toBe('10.0.1.10');
  });

  it('evicts stale lease in old subnet when MAC moves to a new subnet', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const mac = '00:0b:82:01:fc:42';

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, ETH0_INGRESS);
    engine.handle(
      request(DHCPREQUEST, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    const subnets = engine.getSubnets();
    const subA = subnets.find((s) => s.containsIp('10.0.0.10'))!;
    const subB = subnets.find((s) => s.containsIp('10.0.1.10'))!;
    expect(subA.hasLease(mac)).toBe(true);

    engine.handle(
      request(DHCPDISCOVER, {
        chaddr: mac,
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.1.10')]]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    engine.handle(
      request(DHCPREQUEST, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.1.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    expect(subA.hasLease(mac)).toBe(false);
    expect(subB.hasLease(mac)).toBe(true);

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.1.10');
  });

  it('allocates from the first subnet with free space when all are new', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const mac = 'aa:aa:aa:aa:aa:01';
    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('overflows to the second subnet when the first is full', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        {
          interfaceKey: 'eth0',
          subnets: [SUBNET_A, SUBNET_B],
        },
      ],
    });

    for (let i = 1; i <= 3; i++) {
      const mac = `aa:aa:aa:aa:aa:${i.toString(16).padStart(2, '0')}`;
      engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, ETH0_INGRESS);
    }

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: 'bb:bb:bb:bb:bb:01' }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    const yiaddr = decodeReply(offer!.reply).yiaddr;
    expect(yiaddr).toBe('10.0.1.10');
  });
});

describe('Multi-subnet per-subnet lease isolation', () => {
  it('leases in subnet A do not appear in subnet B', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });
    const macA = 'aa:aa:aa:aa:aa:01';
    const macB = 'bb:bb:bb:bb:bb:01';

    engine.handle(request(DHCPDISCOVER, { chaddr: macA }), SERVER_ID, false, ETH0_INGRESS);
    engine.handle(
      request(DHCPREQUEST, {
        chaddr: macA,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    engine.handle(
      request(DHCPDISCOVER, {
        chaddr: macB,
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.1.10')]]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    const subnets = engine.getSubnets();
    const subA = subnets.find((s) => s.containsIp('10.0.0.10'));
    const subB = subnets.find((s) => s.containsIp('10.0.1.10'));
    expect(subA).not.toBeUndefined();
    expect(subB).not.toBeUndefined();

    expect(subA!.hasLease(macA)).toBe(true);
    expect(subA!.hasLease(macB)).toBe(false);

    expect(subB!.hasLease(macB)).toBe(true);
    expect(subB!.hasLease(macA)).toBe(false);
  });
});

describe('Multi-subnet hydrate distributes leases by containment', () => {
  it('distributes lease records to the correct subnet', async () => {
    const store: LeaseStore = {
      loadAll: async (): Promise<LeaseRecord[]> => [
        { ip: '10.0.0.10', mac: 'aa:aa:aa:aa:aa:01', hostname: null, expiresAt: 1e12 },
        { ip: '10.0.1.11', mac: 'bb:bb:bb:bb:bb:01', hostname: null, expiresAt: 1e12 },
      ],
      put: async () => {},
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };

    const engine = DhcpEngine.fromSubnets(
      {
        mode: 'AUTHORITATIVE',
        networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
      },
      undefined,
      store,
    );
    const ok = await engine.hydrate();
    expect(ok).toBe(true);

    const subnets = engine.getSubnets();
    const subA = subnets.find((s) => s.containsIp('10.0.0.10'));
    const subB = subnets.find((s) => s.containsIp('10.0.1.10'));

    expect(subA!.hasLease('aa:aa:aa:aa:aa:01')).toBe(true);
    expect(subA!.hasLease('bb:bb:bb:bb:bb:01')).toBe(false);

    expect(subB!.hasLease('bb:bb:bb:bb:bb:01')).toBe(true);
    expect(subB!.hasLease('aa:aa:aa:aa:aa:01')).toBe(false);
  });

  it('drops lease records that do not match any subnet', async () => {
    const warnings: string[] = [];
    const store: LeaseStore = {
      loadAll: async (): Promise<LeaseRecord[]> => [
        { ip: '192.168.99.1', mac: 'cc:cc:cc:cc:cc:01', hostname: null, expiresAt: 1e12 },
      ],
      put: async () => {},
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };

    const engine = DhcpEngine.fromSubnets(
      {
        mode: 'AUTHORITATIVE',
        networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
      },
      undefined,
      store,
      {
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    );
    await engine.hydrate();

    expect(engine.leases()).toHaveLength(0);
    expect(warnings.some((w) => w.includes('192.168.99.1'))).toBe(true);
  });
});

describe('Single-subnet backward compatibility', () => {
  it('single-subnet fromSubnets behaves identically to the multi-subnet engine', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [makeSubnetConfig()] }],
    });

    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(offer).not.toBeNull();
    const decoded = decodeReply(offer!.reply);
    expect(decoded.messageType).toBe(DHCPOFFER);
    expect(decoded.yiaddr).toBe('10.0.0.10');

    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(engine.leases()).toHaveLength(1);
  });

  it('single-subnet engine with fromSubnets behaves the same', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
    });

    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');

    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
  });

  it('resetLeaseState clears all subnets', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });

    engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:01' }), SERVER_ID, false, ETH0_INGRESS);
    engine.handle(
      request(DHCPDISCOVER, {
        chaddr: 'bb:bb:bb:bb:bb:01',
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.1.10')]]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    expect(engine.leases()).toHaveLength(2);
    engine.resetLeaseState();
    expect(engine.leases()).toHaveLength(0);
  });
});

describe('Multi-subnet RENEW via ciaddr', () => {
  it('routes a RENEW to the correct subnet by ciaddr', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A, SUBNET_B] }],
    });

    const ack = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.1.11' }), SERVER_ID, false, ETH0_INGRESS);
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(decodeReply(ack!.reply).yiaddr).toBe('10.0.1.11');
  });

  it('NAKs a RENEW with ciaddr off all subnets', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
    });

    const nak = engine.handle(request(DHCPREQUEST, { ciaddr: '192.168.1.50' }), SERVER_ID, false, ETH0_INGRESS);
    expect(nak).not.toBeNull();
    expect(decodeReply(nak!.reply).messageType).toBe(DHCPNAK);
  });
});

describe('Multi-subnet INIT-REBOOT via requested-IP option', () => {
  it('NAKs when the requested IP is off all subnets', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
    });

    const nak = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([[OPT_REQUESTED_IP, encodeIp('192.168.99.99')]]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(nak).not.toBeNull();
    expect(decodeReply(nak!.reply).messageType).toBe(DHCPNAK);
  });
});

describe('Multi-subnet ingress fallback', () => {
  it('falls back to all subnets when ingress is null (dgram path)', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
    });

    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID, false, null);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('falls back when ingress interface name does not match any shared network', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_A] }],
    });

    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID, false, { ifindex: 99, ifname: 'unknown0' });
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
  });
});

describe('Multi-subnet per-subnet options', () => {
  it('uses per-subnet mask and routers in the reply', () => {
    const subnetCustom = makeSubnetConfig({
      subnetMask: '255.255.0.0',
      rangeStart: '172.16.0.10',
      rangeEnd: '172.16.0.20',
      routers: ['172.16.0.1'],
      dnsServers: ['8.8.8.8'],
      serverId: '172.16.0.1',
    });
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [subnetCustom] }],
    });

    const offer = engine.handle(request(DHCPDISCOVER), '172.16.0.1', false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    const decoded = decodeReply(offer!.reply);
    expect(decoded.yiaddr).toBe('172.16.0.10');
    expect(decodeIp(decoded.options.get(3)!)).toBe('172.16.0.1');
    expect(decodeIp(decoded.options.get(6)!)).toBe('8.8.8.8');
    expect(decodeIp(decoded.options.get(1)!)).toBe('255.255.0.0');
  });
});

describe('Multi-subnet isOwnServerId (opt-54 matching)', () => {
  it('ACKs a SELECTING REQUEST whose opt-54 is a secondary subnet serverId (not the primary)', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        { interfaceKey: 'eth0', subnets: [SUBNET_A] },
        { interfaceKey: 'eth1', subnets: [SUBNET_B] },
      ],
    });

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:01' }), SERVER_ID, false, ETH1_INGRESS);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.1.10');

    const ack = engine.handle(
      request(DHCPREQUEST, {
        chaddr: 'cc:cc:cc:cc:cc:01',
        options: new Map([
          [OPT_SERVER_ID, encodeIp('10.0.1.1')],
          [OPT_REQUESTED_IP, encodeIp('10.0.1.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH1_INGRESS,
    );
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(decodeReply(ack!.reply).yiaddr).toBe('10.0.1.10');
  });

  it('drops a SELECTING REQUEST whose opt-54 is an unknown serverId', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        { interfaceKey: 'eth0', subnets: [SUBNET_A] },
        { interfaceKey: 'eth1', subnets: [SUBNET_B] },
      ],
    });

    const reply = engine.handle(
      request(DHCPREQUEST, {
        chaddr: 'cc:cc:cc:cc:cc:02',
        options: new Map([
          [OPT_SERVER_ID, encodeIp('192.168.99.99')],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(reply).toBeNull();
  });
});

describe('Multi-subnet per-subnet dnsSelf (opt-6)', () => {
  it('advertises each subnet own in-CIDR DNS self address, not the global serverId', () => {
    const subA = makeSubnetConfig({
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.12',
      routers: ['10.0.0.1'],
      dnsServers: [],
      dnsSelf: true,
      serverId: '10.0.0.1',
    });
    const subB = makeSubnetConfig({
      rangeStart: '10.0.1.10',
      rangeEnd: '10.0.1.12',
      routers: ['10.0.1.1'],
      dnsServers: [],
      dnsSelf: true,
      serverId: '10.0.1.1',
    });
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        { interfaceKey: 'eth0', subnets: [subA] },
        { interfaceKey: 'eth1', subnets: [subB] },
      ],
    });

    engine.setPeerDnsIp('10.0.0.2');

    const offerA = engine.handle(
      request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:01' }),
      '10.0.0.1',
      false,
      ETH0_INGRESS,
    );
    expect(offerA).not.toBeNull();
    const dnsA = decodeReply(offerA!.reply).options.get(OPT_DNS_SERVERS);
    expect(dnsA).toBeDefined();
    expect(decodeIp(dnsA!.subarray(0, 4))).toBe('10.0.0.1');
    expect(dnsA!.length).toBe(8);
    expect(decodeIp(dnsA!.subarray(4, 8))).toBe('10.0.0.2');

    const offerB = engine.handle(
      request(DHCPDISCOVER, { chaddr: 'bb:bb:bb:bb:bb:01' }),
      '10.0.1.1',
      false,
      ETH1_INGRESS,
    );
    expect(offerB).not.toBeNull();
    const dnsB = decodeReply(offerB!.reply).options.get(OPT_DNS_SERVERS);
    expect(dnsB).toBeDefined();
    expect(decodeIp(dnsB!.subarray(0, 4))).toBe('10.0.1.1');
    expect(dnsB!.length).toBe(4);
  });
});
