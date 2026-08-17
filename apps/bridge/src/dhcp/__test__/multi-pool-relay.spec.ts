import { describe, expect, it } from 'vitest';

import {
  DHCPACK,
  DHCPDISCOVER,
  DHCPNAK,
  DHCPOFFER,
  DHCPREQUEST,
  OPT_DNS_SERVERS,
  OPT_REQUESTED_IP,
  OPT_ROUTER,
  OPT_SERVER_ID,
  decodeIp,
  encodeIp,
} from '../dhcp-options.js';
import { DhcpEngine, type IngressInfo } from '../dhcp-server.js';
import { ipToInt } from '../dhcp.config.js';
import { type DhcpMessage, parsePacket } from '../protocol.js';
import { Subnet, type SubnetConfig } from '../subnet.js';
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

const ETH0_INGRESS: IngressInfo = { ifindex: 2, ifname: 'eth0' };

describe('Multi-pool per subnet', () => {
  const TWO_POOL_CONFIG = makeSubnetConfig({
    rangeStart: '',
    rangeEnd: '',
    pools: [
      { start: ipToInt('10.0.0.10'), end: ipToInt('10.0.0.11') },
      { start: ipToInt('10.0.0.20'), end: ipToInt('10.0.0.21') },
    ],
    serverId: '10.0.0.1',
  });

  it('allocates across two pools in order (first free wins)', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [TWO_POOL_CONFIG] }],
    });

    const mac1 = 'aa:aa:aa:aa:aa:01';
    const mac2 = 'aa:aa:aa:aa:aa:02';
    const mac3 = 'aa:aa:aa:aa:aa:03';

    const offer1 = engine.handle(request(DHCPDISCOVER, { chaddr: mac1 }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer1).not.toBeNull();
    expect(decodeReply(offer1!.reply).yiaddr).toBe('10.0.0.10');

    const offer2 = engine.handle(request(DHCPDISCOVER, { chaddr: mac2 }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer2).not.toBeNull();
    expect(decodeReply(offer2!.reply).yiaddr).toBe('10.0.0.11');

    const offer3 = engine.handle(request(DHCPDISCOVER, { chaddr: mac3 }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer3).not.toBeNull();
    expect(decodeReply(offer3!.reply).yiaddr).toBe('10.0.0.20');
  });

  it('exhaust pool 1 -> spill to pool 2 then exhaust pool 2', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [TWO_POOL_CONFIG] }],
    });

    const macs = ['cc:01:01:01:01:01', 'cc:01:01:01:01:02', 'cc:01:01:01:01:03', 'cc:01:01:01:01:04'];
    const expectedIps = ['10.0.0.10', '10.0.0.11', '10.0.0.20', '10.0.0.21'];

    for (let i = 0; i < macs.length; i++) {
      const offer = engine.handle(request(DHCPDISCOVER, { chaddr: macs[i] }), SERVER_ID, false, ETH0_INGRESS);
      expect(offer).not.toBeNull();
      expect(decodeReply(offer!.reply).yiaddr).toBe(expectedIps[i]);
    }

    const offer5 = engine.handle(
      request(DHCPDISCOVER, { chaddr: 'cc:01:01:01:01:05' }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(offer5).toBeNull();
  });

  it('reservation/exclude/gateway OUTSIDE all pools still renews', () => {
    const configWithReservation = makeSubnetConfig({
      rangeStart: '',
      rangeEnd: '',
      pools: [{ start: ipToInt('10.0.0.20'), end: ipToInt('10.0.0.22') }],
      reservations: [{ mac: 'dd:dd:dd:dd:dd:01', ip: '10.0.0.5' }],
      excludeIps: ['10.0.0.1'],
      routers: ['10.0.0.1'],
      serverId: '10.0.0.1',
    });

    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [configWithReservation] }],
    });

    const reservedMac = 'dd:dd:dd:dd:dd:01';

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: reservedMac }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.5');

    const ack = engine.handle(
      request(DHCPREQUEST, {
        chaddr: reservedMac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.5')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);

    const renew = engine.handle(
      request(DHCPREQUEST, { chaddr: reservedMac, ciaddr: '10.0.0.5' }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(renew).not.toBeNull();
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPACK);
    expect(decodeReply(renew!.reply).yiaddr).toBe('10.0.0.5');
  });

  it('single-pool config is unchanged (behavioral regression check)', () => {
    const singlePool = makeSubnetConfig({
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.12',
      serverId: '10.0.0.1',
    });

    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [singlePool] }],
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
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(engine.leases()).toHaveLength(1);
  });

  it('inPool returns true for IPs in any pool and false for gaps between pools', () => {
    const subnet = new Subnet(TWO_POOL_CONFIG, () => 0);
    expect(subnet.inPool('10.0.0.10')).toBe(true);
    expect(subnet.inPool('10.0.0.11')).toBe(true);
    expect(subnet.inPool('10.0.0.15')).toBe(false);
    expect(subnet.inPool('10.0.0.20')).toBe(true);
    expect(subnet.inPool('10.0.0.21')).toBe(true);
    expect(subnet.inPool('10.0.0.5')).toBe(false);
    expect(subnet.inPool('10.0.0.30')).toBe(false);
  });
});

describe('DHCP relay (giaddr) subnet selection', () => {
  const SUBNET_LOCAL = makeSubnetConfig({
    subnetMask: '255.255.255.0',
    rangeStart: '10.0.0.10',
    rangeEnd: '10.0.0.12',
    routers: ['10.0.0.1'],
    dnsServers: ['10.0.0.1'],
    serverId: '10.0.0.1',
    tftpServer: '10.0.0.1',
  });

  const SUBNET_RELAYED = makeSubnetConfig({
    subnetMask: '255.255.255.0',
    rangeStart: '10.0.1.10',
    rangeEnd: '10.0.1.12',
    routers: ['10.0.1.1'],
    dnsServers: ['8.8.8.8'],
    serverId: '10.0.1.1',
    tftpServer: '10.0.1.1',
  });

  it('giaddr selects the correct relayed subnet with no local interface', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [SUBNET_RELAYED],
    });

    const offer = engine.handle(request(DHCPDISCOVER, { giaddr: '10.0.1.1' }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    const decoded = decodeReply(offer!.reply);
    expect(decoded.messageType).toBe(DHCPOFFER);
    expect(decoded.yiaddr).toBe('10.0.1.10');
  });

  it('offer comes from the giaddr-matched subnet pool', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [SUBNET_RELAYED],
    });

    const offerLocal = engine.handle(
      request(DHCPDISCOVER, { giaddr: '10.0.0.1', chaddr: 'ee:ee:ee:ee:ee:01' }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(offerLocal).not.toBeNull();
    expect(decodeReply(offerLocal!.reply).yiaddr).toBe('10.0.0.10');

    const offerRelay = engine.handle(
      request(DHCPDISCOVER, { giaddr: '10.0.1.1', chaddr: 'ee:ee:ee:ee:ee:02' }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(offerRelay).not.toBeNull();
    expect(decodeReply(offerRelay!.reply).yiaddr).toBe('10.0.1.10');
  });

  it('reply targets giaddr:67 for relayed traffic', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [SUBNET_RELAYED],
    });

    const offer = engine.handle(request(DHCPDISCOVER, { giaddr: '10.0.1.1' }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    expect(offer!.target).toEqual({ address: '10.0.1.1', port: 67 });
  });

  it('routers/dns/tftpServer come from the giaddr-matched subnet', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [SUBNET_RELAYED],
    });

    const offer = engine.handle(request(DHCPDISCOVER, { giaddr: '10.0.1.1' }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).not.toBeNull();
    const decoded = decodeReply(offer!.reply);

    expect(decodeIp(decoded.options.get(OPT_ROUTER)!)).toBe('10.0.1.1');
    expect(decodeIp(decoded.options.get(OPT_DNS_SERVERS)!)).toBe('8.8.8.8');
  });

  it('configured relay DISCOVER and REQUEST allocate from the selected subnet pool', () => {
    const relayGiaddr = '172.16.0.1';
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [makeSubnetConfig({ ...SUBNET_RELAYED, relayAgentIp: relayGiaddr })],
    });

    const mac = 'ff:ff:ff:ff:ff:01';

    const offer = engine.handle(
      request(DHCPDISCOVER, { giaddr: relayGiaddr, chaddr: mac }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(offer).not.toBeNull();
    const offeredIp = decodeReply(offer!.reply).yiaddr;
    expect(offeredIp).toBe('10.0.1.10');
    expect(offer!.target).toEqual({ address: relayGiaddr, port: 67 });

    const ack = engine.handle(
      request(DHCPREQUEST, {
        giaddr: relayGiaddr,
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp(offeredIp)],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(ack).not.toBeNull();
    const ackDecoded = decodeReply(ack!.reply);
    expect(ackDecoded.messageType).toBe(DHCPACK);
    expect(ackDecoded.yiaddr).toBe('10.0.1.10');

    expect(ack!.target).toEqual({ address: relayGiaddr, port: 67 });
  });

  it('NAK targets the packet giaddr for a configured relay agent', () => {
    const relayGiaddr = '172.16.0.1';
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [makeSubnetConfig({ ...SUBNET_RELAYED, relayAgentIp: relayGiaddr })],
    });

    const nak = engine.handle(
      request(DHCPREQUEST, {
        giaddr: relayGiaddr,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('192.168.99.10')],
        ]),
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );

    expect(nak).not.toBeNull();
    expect(decodeReply(nak!.reply).messageType).toBe(DHCPNAK);
    expect(nak!.target).toEqual({ address: relayGiaddr, port: 67 });
  });

  it('relayed REQUEST (RENEW via ciaddr) from giaddr-matched subnet', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
      relayed: [SUBNET_RELAYED],
    });

    const relayGiaddr = '10.0.1.1';
    const mac = 'ff:ff:ff:ff:ff:02';

    engine.handle(request(DHCPDISCOVER, { giaddr: relayGiaddr, chaddr: mac }), SERVER_ID, false, ETH0_INGRESS);
    engine.handle(
      request(DHCPREQUEST, {
        giaddr: relayGiaddr,
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

    const renew = engine.handle(
      request(DHCPREQUEST, {
        giaddr: relayGiaddr,
        chaddr: mac,
        ciaddr: '10.0.1.10',
      }),
      SERVER_ID,
      false,
      ETH0_INGRESS,
    );
    expect(renew).not.toBeNull();
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPACK);
    expect(renew!.target).toEqual({ address: relayGiaddr, port: 67 });
  });

  it('giaddr that does not match any subnet returns null (drop)', () => {
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [{ interfaceKey: 'eth0', subnets: [SUBNET_LOCAL] }],
    });

    const offer = engine.handle(request(DHCPDISCOVER, { giaddr: '192.168.99.1' }), SERVER_ID, false, ETH0_INGRESS);
    expect(offer).toBeNull();
  });
});
