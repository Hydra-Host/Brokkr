import { describe, expect, it } from 'vitest';

import { LIMITED_BROADCAST } from '../broadcast-socket.js';
import {
  DHCPACK,
  DHCPDECLINE,
  DHCPDISCOVER,
  DHCPINFORM,
  DHCPNAK,
  DHCPOFFER,
  DHCPRELEASE,
  DHCPREQUEST,
  OPT_BOOTFILE,
  OPT_BROADCAST,
  OPT_CLIENT_ARCH,
  OPT_DNS_SERVERS,
  OPT_LEASE_TIME,
  OPT_MAX_MSG_SIZE,
  OPT_PARAM_REQ_LIST,
  OPT_REBINDING_TIME,
  OPT_RENEWAL_TIME,
  OPT_REQUESTED_IP,
  OPT_ROUTER,
  OPT_SERVER_ID,
  OPT_SUBNET_MASK,
  OPT_TFTP_SERVER,
  OPT_USER_CLASS,
  OPT_VENDOR_CLASS,
  OPT_VENDOR_ENCAP,
  decodeIp,
  encodeIp,
  encodeIps,
  encodeUint32,
} from '../dhcp-options.js';
import { DhcpEngine } from '../dhcp-server.js';
import type { DhcpMode, DhcpOptionSpec } from '../dhcp.config.js';
import type { LeaseRecord } from '../lease-store/lease-record.js';
import type { LeaseStore } from '../lease-store/lease-store.js';
import { type DhcpMessage, parsePacket } from '../protocol.js';
import type { PxeDecision } from '../pxe-decision.js';
import type { SubnetConfig } from '../subnet.js';
import { request } from './test-factories.js';

const SERVER_ID = '10.0.0.1';

function makeSubnetConfig(overrides: Partial<SubnetConfig> = {}): SubnetConfig {
  return {
    serverId: SERVER_ID,
    rangeStart: '10.0.0.10',
    rangeEnd: '10.0.0.12',
    subnetMask: '255.255.255.0',
    routers: ['10.0.0.1'],
    dnsServers: ['10.0.0.1'],
    dnsSelf: false,
    leaseTtlSeconds: 3600,
    reservations: [],
    excludeIps: [],
    tftpServer: '',
    bootfile: '',
    bootfileByArch: new Map(),
    bootBootfile: '',
    bootServerName: '',
    bootServerAddress: '',
    declineBackoffSeconds: 600,
    dhcpOptions: [],
    ...overrides,
  };
}

function buildEngine(
  overrides: Partial<SubnetConfig> & { mode?: DhcpMode } = {},
  now?: () => number,
  leaseStore?: LeaseStore,
): DhcpEngine {
  const { mode = 'AUTHORITATIVE', ...subnetOverrides } = overrides;
  const sc = makeSubnetConfig(subnetOverrides);
  return DhcpEngine.fromSubnets({ mode, networks: [{ interfaceKey: 'eth0', subnets: [sc] }] }, now, leaseStore);
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

describe('DhcpEngine DISCOVER/REQUEST', () => {
  it('offers the first free pool address and ACKs the matching REQUEST', () => {
    const engine = buildEngine();

    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(offer).not.toBeNull();
    const decodedOffer = decodeReply(offer!.reply);
    expect(decodedOffer.messageType).toBe(DHCPOFFER);
    expect(decodedOffer.yiaddr).toBe('10.0.0.10');
    expect(decodeIp(decodedOffer.options.get(OPT_SERVER_ID)!)).toBe(SERVER_ID);
    expect(decodeIp(decodedOffer.options.get(OPT_SUBNET_MASK)!)).toBe('255.255.255.0');
    expect(decodeIp(decodedOffer.options.get(OPT_ROUTER)!)).toBe('10.0.0.1');
    expect(decodeIp(decodedOffer.options.get(OPT_DNS_SERVERS)!)).toBe('10.0.0.1');
    expect(decodedOffer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
    expect(decodeIp(decodedOffer.options.get(OPT_BROADCAST)!)).toBe('10.0.0.255');
    expect(offer!.target).toEqual({ address: LIMITED_BROADCAST, port: 68 });

    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    const decodedAck = decodeReply(ack!.reply);
    expect(decodedAck.messageType).toBe(DHCPACK);
    expect(decodedAck.yiaddr).toBe('10.0.0.10');
    expect(decodeIp(decodedAck.options.get(OPT_BROADCAST)!)).toBe('10.0.0.255');
    expect(engine.leases()).toHaveLength(1);
  });

  it('resetLeaseState clears in-RAM leases (used on leadership loss)', () => {
    const engine = buildEngine();
    engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(engine.leases()).toHaveLength(1);

    engine.resetLeaseState();
    expect(engine.leases()).toHaveLength(0);

    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('NAKs a SELECTING REQUEST whose offered address we cannot satisfy', () => {
    const engine = buildEngine();
    const nak = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('192.168.99.99')],
        ]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(nak!.reply).messageType).toBe(DHCPNAK);
    expect(nak!.target.address).toBe(LIMITED_BROADCAST);
  });

  it('ignores a SELECTING REQUEST that selected a different server (option 54)', () => {
    const engine = buildEngine();
    const result = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp('10.0.0.99')],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(result).toBeNull();
  });

  it('gives the same MAC a sticky address across DISCOVERs', () => {
    const engine = buildEngine();
    const mac = '00:0b:82:01:fc:42';
    const first = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    const second = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(decodeReply(first!.reply).yiaddr).toBe(decodeReply(second!.reply).yiaddr);
  });

  it('re-allocates a sticky lease whose IP is now in excludeIps', async () => {
    const mac = '00:0b:82:01:fc:42';
    const store: LeaseStore = {
      loadAll: async (): Promise<LeaseRecord[]> => [{ ip: '10.0.0.10', mac, hostname: null, expiresAt: 1e12 }],
      put: async () => {},
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };
    const engine = buildEngine({ excludeIps: ['10.0.0.10'] }, undefined, store);
    await engine.hydrate();

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    const yiaddr = decodeReply(offer!.reply).yiaddr;
    expect(yiaddr).not.toBe('10.0.0.10');
    expect(['10.0.0.11', '10.0.0.12']).toContain(yiaddr);
  });

  it('re-allocates a sticky lease whose IP is out of pool', async () => {
    const mac = '00:0b:82:01:fc:42';
    const store: LeaseStore = {
      loadAll: async (): Promise<LeaseRecord[]> => [{ ip: '10.0.0.99', mac, hostname: null, expiresAt: 1e12 }],
      put: async () => {},
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };
    const engine = buildEngine({}, undefined, store);
    await engine.hydrate();

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    const yiaddr = decodeReply(offer!.reply).yiaddr;
    expect(['10.0.0.10', '10.0.0.11', '10.0.0.12']).toContain(yiaddr);
  });

  it('hands distinct addresses to distinct MACs and exhausts the pool', () => {
    const engine = buildEngine();
    const ips = ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02', 'aa:aa:aa:aa:aa:03'].map(
      (mac) => decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr,
    );
    expect(new Set(ips)).toEqual(new Set(['10.0.0.10', '10.0.0.11', '10.0.0.12']));
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:04' }), SERVER_ID)).toBeNull();
  });

  it('offers interior .0/.255 hosts on a wide mask, skipping only the real network and broadcast', () => {
    const engine = buildEngine({
      rangeStart: '10.0.0.0',
      rangeEnd: '10.0.1.0',
      subnetMask: '255.255.252.0',
      routers: ['10.0.0.1'],
      serverId: '10.0.0.1',
    });
    const offered = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const mac = `aa:bb:cc:00:${((i >> 8) & 0xff).toString(16).padStart(2, '0')}:${(i & 0xff).toString(16).padStart(2, '0')}`;
      const reply = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), '10.0.0.1');
      if (reply === null) break;
      offered.add(decodeReply(reply.reply).yiaddr);
    }
    expect(offered.has('10.0.1.0')).toBe(true);
    expect(offered.has('10.0.0.0')).toBe(false);
    expect(offered.has('10.0.3.255')).toBe(false);
  });

  it('excludes the network/broadcast on a high-bit subnet (192.168/24) where signed & would go negative', () => {
    const engine = buildEngine({
      rangeStart: '192.168.1.0',
      rangeEnd: '192.168.1.255',
      subnetMask: '255.255.255.0',
      routers: ['192.168.1.1'],
      serverId: '192.168.1.1',
    });
    const offered = new Set<string>();
    for (let i = 0; i < 260; i++) {
      const mac = `aa:cc:dd:00:00:${(i & 0xff).toString(16).padStart(2, '0')}`;
      const reply = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), '192.168.1.1');
      if (reply === null) break;
      offered.add(decodeReply(reply.reply).yiaddr);
    }
    expect(offered.has('192.168.1.0')).toBe(false);
    expect(offered.has('192.168.1.255')).toBe(false);
    expect(offered.has('192.168.1.42')).toBe(true);
  });

  it('keeps /24 behavior unchanged: no network/broadcast host appears in a /24 pool', () => {
    const engine = buildEngine();
    const offered = new Set<string>();
    for (const mac of ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02', 'aa:aa:aa:aa:aa:03']) {
      offered.add(decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr);
    }
    expect(offered).toEqual(new Set(['10.0.0.10', '10.0.0.11', '10.0.0.12']));
    expect(offered.has('10.0.0.0')).toBe(false);
    expect(offered.has('10.0.0.255')).toBe(false);
  });
});

describe('DhcpEngine reservations', () => {
  it('always offers the reserved IP, skipping it in the dynamic pool', () => {
    const engine = buildEngine({ reservations: [{ mac: '00:0b:82:01:fc:42', ip: '10.0.0.11' }] });
    const reserved = engine.handle(request(DHCPDISCOVER, { chaddr: '00:0b:82:01:fc:42' }), SERVER_ID);
    expect(decodeReply(reserved!.reply).yiaddr).toBe('10.0.0.11');

    const dynamicIps = ['bb:bb:bb:bb:bb:01', 'bb:bb:bb:bb:bb:02'].map(
      (mac) => decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr,
    );
    expect(dynamicIps).not.toContain('10.0.0.11');
    expect(new Set(dynamicIps)).toEqual(new Set(['10.0.0.10', '10.0.0.12']));
  });
});

describe('DhcpEngine lease release / decline', () => {
  it('returns a released address to the pool', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.10' });
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:cc' }), SERVER_ID)).toBeNull();

    const release = engine.handle(
      request(DHCPRELEASE, {
        chaddr: mac,
        ciaddr: '10.0.0.10',
        options: new Map([[OPT_SERVER_ID, encodeIp(SERVER_ID)]]),
      }),
      SERVER_ID,
    );
    expect(release).toBeNull();
    const reoffer = engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:cc' }), SERVER_ID);
    expect(decodeReply(reoffer!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('prefers the prior IP when the same client re-DISCOVERs after RELEASE (RFC 2131 §4.3.4)', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.11' });
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr).toBe(
      '10.0.0.10',
    );

    engine.handle(
      request(DHCPRELEASE, {
        chaddr: mac,
        ciaddr: '10.0.0.10',
        options: new Map([[OPT_SERVER_ID, encodeIp(SERVER_ID)]]),
      }),
      SERVER_ID,
    );

    const rediscover = engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(decodeReply(rediscover!.reply).yiaddr).toBe('10.0.0.10');
  });

  it('drops the lease on DECLINE and sends no reply', () => {
    const engine = buildEngine();
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(engine.leases()).toHaveLength(1);
    const decline = request(DHCPDECLINE, {
      chaddr: mac,
      options: new Map([
        [OPT_SERVER_ID, encodeIp(SERVER_ID)],
        [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
      ]),
    });
    expect(engine.handle(decline, SERVER_ID)).toBeNull();
    expect(engine.leases()).toHaveLength(0);
  });

  it('permanently blocks a declined address when backoff is disabled (RFC 2131 §4.3.3)', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.10', declineBackoffSeconds: 0 });
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    engine.handle(
      request(DHCPDECLINE, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:cc' }), SERVER_ID)).toBeNull();
  });

  it('ignores a DECLINE/RELEASE addressed to a different server (opt 54)', () => {
    const engine = buildEngine();
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    const wrongServer = new Map([[OPT_SERVER_ID, encodeIp('10.0.0.99')]]);
    engine.handle(request(DHCPRELEASE, { chaddr: mac, ciaddr: '10.0.0.10', options: wrongServer }), SERVER_ID);
    engine.handle(request(DHCPDECLINE, { chaddr: mac, options: wrongServer }), SERVER_ID);
    expect(engine.leases()).toHaveLength(1);
  });

  it('flags a NAK reply with isNak (drives broadcast-NAK routing)', () => {
    const engine = buildEngine();
    const reply = engine.handle(
      request(DHCPREQUEST, {
        chaddr: '00:0b:82:01:fc:42',
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.9.9.9')],
        ]),
      }),
      SERVER_ID,
    );
    expect(reply).not.toBeNull();
    expect(decodeReply(reply!.reply).messageType).toBe(DHCPNAK);
    expect(reply!.isNak).toBe(true);
  });

  describe('per-subnet server-id (opt 54) on a secondary interface', () => {
    const SECONDARY_ID = '10.0.1.1';
    const eth1 = { ifindex: 2, ifname: 'eth1' };
    const mac = '00:0b:82:01:fc:42';

    function buildDualEngine(): DhcpEngine {
      const primary = makeSubnetConfig({ serverId: SERVER_ID });
      const secondary = makeSubnetConfig({
        serverId: SECONDARY_ID,
        rangeStart: '10.0.1.10',
        rangeEnd: '10.0.1.10',
        routers: [SECONDARY_ID],
        dnsServers: [SECONDARY_ID],
      });
      return DhcpEngine.fromSubnets({
        mode: 'AUTHORITATIVE',
        networks: [
          { interfaceKey: 'eth0', subnets: [primary] },
          { interfaceKey: 'eth1', subnets: [secondary] },
        ],
      });
    }

    function leaseOnSecondary(engine: DhcpEngine): void {
      engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, eth1);
      engine.handle(
        request(DHCPREQUEST, {
          chaddr: mac,
          options: new Map([
            [OPT_SERVER_ID, encodeIp(SECONDARY_ID)],
            [OPT_REQUESTED_IP, encodeIp('10.0.1.10')],
          ]),
        }),
        SERVER_ID,
        false,
        eth1,
      );
    }

    it('advertises the secondary subnet server-id (opt 54) in its OFFER, not the global primary', () => {
      const engine = buildDualEngine();
      const offer = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID, false, eth1)!.reply);
      expect(decodeIp(offer.options.get(OPT_SERVER_ID)!)).toBe(SECONDARY_ID);
    });

    it('honours a DECLINE naming the secondary server-id — blocks the declined address', () => {
      const engine = buildDualEngine();
      leaseOnSecondary(engine);
      engine.handle(
        request(DHCPDECLINE, {
          chaddr: mac,
          options: new Map([
            [OPT_SERVER_ID, encodeIp(SECONDARY_ID)],
            [OPT_REQUESTED_IP, encodeIp('10.0.1.10')],
          ]),
        }),
        SERVER_ID,
        false,
        eth1,
      );
      expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:cc' }), SERVER_ID, false, eth1)).toBeNull();
    });

    it('honours a RELEASE naming the secondary server-id — clears the lease', () => {
      const engine = buildDualEngine();
      leaseOnSecondary(engine);
      expect(engine.leases().find((l) => l.mac === mac)?.expiresAt).toBeGreaterThan(0);
      engine.handle(
        request(DHCPRELEASE, {
          chaddr: mac,
          ciaddr: '10.0.1.10',
          options: new Map([[OPT_SERVER_ID, encodeIp(SECONDARY_ID)]]),
        }),
        SERVER_ID,
        false,
        eth1,
      );
      expect(engine.leases().find((l) => l.mac === mac)?.expiresAt).toBe(0);
    });

    it('answers an INFORM on the secondary subnet with that subnet server-id (opt 54)', () => {
      const engine = buildDualEngine();
      const reply = engine.handle(request(DHCPINFORM, { chaddr: mac, ciaddr: '10.0.1.50' }), SERVER_ID, false, eth1)!;
      expect(reply).not.toBeNull();
      const decoded = decodeReply(reply.reply);
      expect(decoded.messageType).toBe(DHCPACK);
      expect(decodeIp(decoded.options.get(OPT_SERVER_ID)!)).toBe(SECONDARY_ID);
    });
  });

  it('ignores a RELEASE with no opt-54 (RFC 2131 Table 5: opt 54 is MUST)', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.10' });
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(engine.leases()).toHaveLength(1);
    engine.handle(request(DHCPRELEASE, { chaddr: mac, ciaddr: '10.0.0.10', options: new Map() }), SERVER_ID);
    expect(engine.leases()).toHaveLength(1);
    expect(engine.leases()[0]!.expiresAt).toBeGreaterThan(0);
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:cc' }), SERVER_ID)).toBeNull();
  });

  it('reclaims an expired lease for a different MAC', () => {
    let now = 1000;
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.10' }, () => now);
    engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:01' }), SERVER_ID);
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:02' }), SERVER_ID)).toBeNull();
    now += 3601;
    const reoffer = engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:02' }), SERVER_ID);
    expect(decodeReply(reoffer!.reply).yiaddr).toBe('10.0.0.10');
  });
});

describe('DhcpEngine INFORM', () => {
  it('ACKs options without a lease or yiaddr, unicast to ciaddr', () => {
    const engine = buildEngine();
    const ack = engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID);
    const decoded = decodeReply(ack!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('0.0.0.0');
    expect(decoded.options.has(OPT_LEASE_TIME)).toBe(false);
    expect(decoded.options.has(OPT_BROADCAST)).toBe(false);
    expect(engine.leases()).toHaveLength(0);
    expect(ack!.target).toEqual({ address: '10.0.0.50', port: 68 });
  });

  it('echoes ciaddr in the INFORM ACK (RFC 2131 s4.3.1 Table 3)', () => {
    const engine = buildEngine();
    const ack = engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID);
    const parsed = reparseReply(ack!.reply);
    expect(parsed.ciaddr).toBe('10.0.0.50');
  });

  it('unicasts the INFORM ACK to ciaddr even when the broadcast flag is set (RFC 2131 §4.1)', () => {
    const engine = buildEngine();
    const ack = engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50', broadcast: true }), SERVER_ID);
    expect(ack!.target).toEqual({ address: '10.0.0.50', port: 68 });
  });

  it('leaves siaddr 0.0.0.0 on an INFORM ACK while still carrying PRL operator options (RFC 2131 §4.3.5)', () => {
    const engine = buildEngine({ dnsServers: ['1.1.1.1'] });
    const ack = engine.handle(
      request(DHCPINFORM, { ciaddr: '10.0.0.50', options: prl(OPT_DNS_SERVERS) }),
      SERVER_ID,
    )!.reply;
    expect(reparseReply(ack).siaddr).toBe('0.0.0.0');
    const decoded = decodeReply(ack);
    expect(decoded.yiaddr).toBe('0.0.0.0');
    expect(decoded.options.has(OPT_LEASE_TIME)).toBe(false);
    expect(decodeIp(decoded.options.get(OPT_DNS_SERVERS)!)).toBe('1.1.1.1');
  });
});

describe('DhcpEngine opt-6 DNS self-reference (dnsSelf)', () => {
  it('emits opt-6 = [serverId] on OFFER and ACK when dnsSelf is set and no explicit dnsServers', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });

    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);

    const ack = decodeReply(
      engine.handle(
        request(DHCPREQUEST, {
          options: new Map([
            [OPT_SERVER_ID, encodeIp(SERVER_ID)],
            [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
          ]),
        }),
        SERVER_ID,
      )!.reply,
    );
    expect(decodeIp(ack.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
  });

  it('emits opt-6 = [serverId] on the INFORM ACK', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });
    const ack = decodeReply(engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID)!.reply);
    expect(decodeIp(ack.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
  });

  it('lets explicit dnsServers win over dnsSelf (self suppressed)', () => {
    const engine = buildEngine({ dnsServers: ['1.1.1.1', '8.8.8.8'], dnsSelf: true });
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(Buffer.from(offer.options.get(OPT_DNS_SERVERS)!)).toEqual(encodeIps(['1.1.1.1', '8.8.8.8']));
  });

  it('omits opt-6 entirely when dnsSelf is unset and no explicit dnsServers', () => {
    const engine = buildEngine({ dnsServers: [] });
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(offer.options.has(OPT_DNS_SERVERS)).toBe(false);
  });

  it('never emits opt-6 with the unspecified address (0.0.0.0) as a resolver', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true, serverId: '' });
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), '0.0.0.0')!.reply);
    expect(offer.options.has(OPT_DNS_SERVERS)).toBe(false);
  });

  it('emits opt-6 = [serverId, peer] when dnsSelf and a peer DNS IP is set', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });
    engine.setPeerDnsIp('10.0.0.3');
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(Buffer.from(offer.options.get(OPT_DNS_SERVERS)!)).toEqual(encodeIps([SERVER_ID, '10.0.0.3']));
  });

  it('emits opt-6 = [serverId] when the peer DNS IP is null (peer not yet known)', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });
    engine.setPeerDnsIp(null);
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
  });

  it('dedupes the peer DNS IP when it equals serverId', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });
    engine.setPeerDnsIp(SERVER_ID);
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
  });

  it('skips a 0.0.0.0 peer DNS IP, emitting opt-6 = [serverId]', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });
    engine.setPeerDnsIp('0.0.0.0');
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
  });

  it('skips an invalid (non-IPv4) peer DNS IP, emitting opt-6 = [serverId]', () => {
    const engine = buildEngine({ dnsServers: [], dnsSelf: true });
    engine.setPeerDnsIp('not-an-ip');
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
  });

  it('skips a non-routable peer DNS IP (loopback/link-local), emitting opt-6 = [serverId] (BB-14)', () => {
    for (const nonRoutable of ['127.0.0.1', '169.254.1.1']) {
      const engine = buildEngine({ dnsServers: [], dnsSelf: true });
      engine.setPeerDnsIp(nonRoutable);
      const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
      expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe(SERVER_ID);
    }
  });

  it('lets explicit dnsServers win over dnsSelf + peer (both suppressed)', () => {
    const engine = buildEngine({ dnsServers: ['1.1.1.1'], dnsSelf: true });
    engine.setPeerDnsIp('10.0.0.3');
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(Buffer.from(offer.options.get(OPT_DNS_SERVERS)!)).toEqual(encodeIps(['1.1.1.1']));
  });
});

describe('DhcpEngine PXE', () => {
  it('adds next-server/option-66/67 for a PXE client with an arch-specific bootfile', () => {
    const engine = buildEngine({
      tftpServer: '10.0.0.1',
      bootfile: 'default.kpxe',
      bootfileByArch: new Map([[7, 'ipxe.efi']]),
    });
    const arch = Buffer.alloc(2);
    arch.writeUInt16BE(7, 0);
    const offer = engine.handle(
      request(DHCPDISCOVER, {
        options: new Map([
          [OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00007', 'ascii')],
          [93, arch],
        ]),
      }),
      SERVER_ID,
    );
    const decoded = decodeReply(offer!.reply);
    expect(decoded.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.1');
    expect(asciiUntilNul(decoded.options.get(OPT_BOOTFILE)!)).toBe('ipxe.efi');
    expect(decoded.options.has(OPT_VENDOR_CLASS)).toBe(false);
    expect(decoded.options.has(OPT_VENDOR_ENCAP)).toBe(false);
    expect(reparseReply(offer!.reply).siaddr).toBe('10.0.0.1');
  });

  it('serves a reservation its per-device bootfile override, others get the subnet default', () => {
    const RES_MAC = '00:0b:82:01:fc:42';
    const engine = buildEngine({
      tftpServer: '10.0.0.1',
      bootfile: 'snponly-amd64.efi',
      bootfileByArch: new Map([[7, 'snponly-amd64.efi']]),
      reservations: [
        { mac: RES_MAC, ip: '10.0.0.11', bootfile: 'ipxe-amd64.efi', bootfileByArch: new Map([[7, 'ipxe-amd64.efi']]) },
      ],
    });
    const arch = Buffer.alloc(2);
    arch.writeUInt16BE(7, 0);
    const pxeOpts = () =>
      new Map([
        [OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00007', 'ascii')],
        [93, arch],
      ]);

    const reserved = engine.handle(request(DHCPDISCOVER, { chaddr: RES_MAC, options: pxeOpts() }), SERVER_ID);
    expect(asciiUntilNul(decodeReply(reserved!.reply).options.get(OPT_BOOTFILE)!)).toBe('ipxe-amd64.efi');

    const other = engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:aa', options: pxeOpts() }), SERVER_ID);
    expect(asciiUntilNul(decodeReply(other!.reply).options.get(OPT_BOOTFILE)!)).toBe('snponly-amd64.efi');
  });

  it('omits PXE fields for a non-PXE client', () => {
    const engine = buildEngine({ tftpServer: '10.0.0.1', bootfile: 'default.kpxe' });
    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    const decoded = decodeReply(offer!.reply);
    expect(decoded.options.has(OPT_TFTP_SERVER)).toBe(false);
    expect(decoded.options.has(OPT_BOOTFILE)).toBe(false);
  });

  it('omits opt-60/opt-43 on the direct authoritative PXE OFFER and ACK, keeping siaddr+opt66+opt67', () => {
    const engine = buildEngine({ tftpServer: '10.0.0.1', bootfile: 'default.kpxe' });
    const pxe = new Map([[OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')]]);

    const offerReply = engine.handle(request(DHCPDISCOVER, { options: pxe }), SERVER_ID)!.reply;
    const offer = decodeReply(offerReply);
    expect(offer.options.has(OPT_VENDOR_CLASS)).toBe(false);
    expect(offer.options.has(OPT_VENDOR_ENCAP)).toBe(false);
    expect(offer.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.1');
    expect(asciiUntilNul(offer.options.get(OPT_BOOTFILE)!)).toBe('default.kpxe');
    expect(reparseReply(offerReply).siaddr).toBe('10.0.0.1');

    const ackReply = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp(offer.yiaddr)],
          [OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')],
        ]),
      }),
      SERVER_ID,
    )!.reply;
    const ack = decodeReply(ackReply);
    expect(ack.options.has(OPT_VENDOR_CLASS)).toBe(false);
    expect(ack.options.has(OPT_VENDOR_ENCAP)).toBe(false);
    expect(ack.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.1');
    expect(asciiUntilNul(ack.options.get(OPT_BOOTFILE)!)).toBe('default.kpxe');
    expect(reparseReply(ackReply).siaddr).toBe('10.0.0.1');

    const plain = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(plain.options.has(OPT_VENDOR_CLASS)).toBe(false);
  });

  it('emits no PXE options when no TFTP server is configured, even for an arch client', () => {
    const engine = buildEngine({ tftpServer: '' });
    const arch = Buffer.alloc(2);
    arch.writeUInt16BE(7, 0);
    const offer = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: new Map([[OPT_CLIENT_ARCH, arch]]) }), SERVER_ID)!.reply,
    );
    expect(offer.options.has(OPT_VENDOR_CLASS)).toBe(false);
    expect(offer.options.has(OPT_VENDOR_ENCAP)).toBe(false);
    expect(offer.options.has(OPT_TFTP_SERVER)).toBe(false);
  });

  it('PXE-12: suppresses opt-67 for an iPXE user-class (opt-77) DISCOVER, but serves firmware', () => {
    const engine = buildEngine({
      tftpServer: '10.0.0.1',
      bootfile: 'snponly-amd64.efi',
      bootfileByArch: new Map([[7, 'snponly-amd64.efi']]),
    });
    const arch = Buffer.alloc(2);
    arch.writeUInt16BE(7, 0);

    const ipxe = decodeReply(
      engine.handle(
        request(DHCPDISCOVER, {
          options: new Map([
            [OPT_CLIENT_ARCH, arch],
            [OPT_USER_CLASS, Buffer.from('iPXE', 'ascii')],
          ]),
        }),
        SERVER_ID,
      )!.reply,
    );
    expect(ipxe.options.has(OPT_BOOTFILE)).toBe(false);
    expect(ipxe.options.has(OPT_VENDOR_ENCAP)).toBe(false);

    const firmware = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: new Map([[OPT_CLIENT_ARCH, arch]]) }), SERVER_ID)!.reply,
    );
    expect(asciiUntilNul(firmware.options.get(OPT_BOOTFILE)!)).toBe('snponly-amd64.efi');
    expect(firmware.options.has(OPT_VENDOR_CLASS)).toBe(false);
    expect(firmware.options.has(OPT_VENDOR_ENCAP)).toBe(false);
  });

  it('local-sim-9biw: UEFI arch-93 direct offer carries siaddr+opt66+opt67, never opt60/opt43', () => {
    const engine = buildEngine({
      tftpServer: '10.0.1.2',
      bootfile: 'ipxe-amd64.efi',
      bootfileByArch: new Map([[93, 'ipxe-amd64.efi']]),
    });
    const arch = Buffer.alloc(2);
    arch.writeUInt16BE(93, 0);
    const offerReply = engine.handle(
      request(DHCPDISCOVER, {
        options: new Map([
          [OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00093', 'ascii')],
          [OPT_CLIENT_ARCH, arch],
        ]),
      }),
      SERVER_ID,
    )!.reply;
    const offer = decodeReply(offerReply);
    expect(reparseReply(offerReply).siaddr).toBe('10.0.1.2');
    expect(offer.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.1.2');
    expect(asciiUntilNul(offer.options.get(OPT_BOOTFILE)!)).toBe('ipxe-amd64.efi');
    expect(offer.options.has(OPT_VENDOR_CLASS)).toBe(false);
    expect(offer.options.has(OPT_VENDOR_ENCAP)).toBe(false);
  });
});

describe('DhcpEngine T1/T2 timers (options 58/59)', () => {
  it('emits Kea-parity renewal (lease*0.25) and rebinding (lease*0.5) alongside the lease time', () => {
    const engine = buildEngine({ leaseTtlSeconds: 800 });
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(800);
    expect(offer.options.get(OPT_RENEWAL_TIME)!.readUInt32BE(0)).toBe(200);
    expect(offer.options.get(OPT_REBINDING_TIME)!.readUInt32BE(0)).toBe(400);
  });

  it('omits the timers from an INFORM ACK (no lease)', () => {
    const engine = buildEngine();
    const ack = decodeReply(engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID)!.reply);
    expect(ack.options.has(OPT_RENEWAL_TIME)).toBe(false);
    expect(ack.options.has(OPT_REBINDING_TIME)).toBe(false);
  });
});

describe('DhcpEngine DECLINE backoff', () => {
  it('does not re-offer a declined address until the backoff window passes', () => {
    let now = 1000;
    const engine = buildEngine(
      { rangeStart: '10.0.0.10', rangeEnd: '10.0.0.11', declineBackoffSeconds: 600 },
      () => now,
    );
    const mac = 'aa:aa:aa:aa:aa:01';
    const offered = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr;

    engine.handle(
      request(DHCPDECLINE, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp(offered)],
        ]),
      }),
      SERVER_ID,
    );

    const next = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: 'bb:bb:bb:bb:bb:01' }), SERVER_ID)!.reply);
    expect(next.yiaddr).not.toBe(offered);

    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:01' }), SERVER_ID)).toBeNull();

    now += 601;
    const reoffered = decodeReply(
      engine.handle(request(DHCPDISCOVER, { chaddr: 'dd:dd:dd:dd:dd:01' }), SERVER_ID)!.reply,
    );
    expect(reoffered.yiaddr).toBe(offered);
  });
});

describe('DhcpEngine RENEWING/REBINDING (ciaddr)', () => {
  it('ACKs a renewal via ciaddr after a restart that lost the lease DB', () => {
    const engine = buildEngine();
    const renew = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.11' }), SERVER_ID);
    const decoded = decodeReply(renew!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('10.0.0.11');
    expect(decodeIp(decoded.options.get(OPT_BROADCAST)!)).toBe('10.0.0.255');
    expect(renew!.target).toEqual({ address: '10.0.0.11', port: 68 });
    expect(engine.leases()).toHaveLength(1);
  });

  it('echoes ciaddr in the DHCPACK for a RENEWING client (RFC 2131 s4.3.1 Table 3)', () => {
    const engine = buildEngine();
    const renew = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.11' }), SERVER_ID);
    const parsed = reparseReply(renew!.reply);
    expect(parsed.ciaddr).toBe('10.0.0.11');
  });

  it('leaves ciaddr as 0.0.0.0 in a SELECTING DHCPACK (RFC 2131 s4.3.1 Table 3)', () => {
    const engine = buildEngine();
    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    const parsed = reparseReply(ack!.reply);
    expect(parsed.ciaddr).toBe('0.0.0.0');
  });

  it('stays silent for an on-subnet out-of-pool ciaddr (likely a peer-held lease)', () => {
    const engine = buildEngine();
    const renew = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.200' }), SERVER_ID);
    expect(renew).toBeNull();
  });

  it('ACKs an on-subnet out-of-pool ciaddr when THIS bridge holds the binding (narrowed pool)', async () => {
    const mac = '00:0b:82:01:fc:42';
    const store: LeaseStore = {
      loadAll: async (): Promise<LeaseRecord[]> => [{ ip: '10.0.0.200', mac, hostname: null, expiresAt: 1e12 }],
      put: async () => {},
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };
    const engine = buildEngine({}, undefined, store);
    await engine.hydrate();
    const renew = engine.handle(request(DHCPREQUEST, { chaddr: mac, ciaddr: '10.0.0.200' }), SERVER_ID);
    expect(renew).not.toBeNull();
    const decoded = decodeReply(renew!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('10.0.0.200');
  });

  it('NAKs a renewal for an off-subnet ciaddr (wrong net)', () => {
    const engine = buildEngine();
    const renew = engine.handle(request(DHCPREQUEST, { ciaddr: '192.168.5.5' }), SERVER_ID);
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPNAK);
  });

  it('NAKs a renewal for an in-pool but EXCLUDED ciaddr (e.g. the gateway/serverId)', () => {
    const engine = buildEngine({ excludeIps: ['10.0.0.11'] });
    const renew = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.11' }), SERVER_ID);
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPNAK);
  });

  it('still ACKs a renewal for an in-pool NON-excluded ciaddr (legit self-heal preserved)', () => {
    const engine = buildEngine({ excludeIps: ['10.0.0.11'] });
    const renew = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.10' }), SERVER_ID);
    const decoded = decodeReply(renew!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('10.0.0.10');
  });

  it('ACKs a renewal that carries opt-54 but no opt-50 (keyed on opt-50 absence)', () => {
    const engine = buildEngine();
    const renew = engine.handle(
      request(DHCPREQUEST, {
        ciaddr: '10.0.0.11',
        options: new Map([[OPT_SERVER_ID, encodeIp(SERVER_ID)]]),
      }),
      SERVER_ID,
    );
    const decoded = decodeReply(renew!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('10.0.0.11');
  });

  it('ACKs a renewal naming a FOREIGN server in opt-54 (no opt-50 → renewal, not select)', () => {
    const engine = buildEngine();
    const renew = engine.handle(
      request(DHCPREQUEST, {
        ciaddr: '10.0.0.11',
        options: new Map([[OPT_SERVER_ID, encodeIp('10.0.0.99')]]),
      }),
      SERVER_ID,
    );
    const decoded = decodeReply(renew!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('10.0.0.11');
  });
});

describe('DhcpEngine INIT-REBOOT (opt 50, no opt 54)', () => {
  it('NAKs a requested IP on the wrong subnet (RFC 2131 §4.3.2)', () => {
    const engine = buildEngine();
    const result = engine.handle(
      request(DHCPREQUEST, { options: new Map([[OPT_REQUESTED_IP, encodeIp('192.168.99.99')]]) }),
      SERVER_ID,
    );
    expect(decodeReply(result!.reply).messageType).toBe(DHCPNAK);
  });

  it('stays silent for an on-subnet address we have no record of (RFC 2131 §4.3.2)', () => {
    const engine = buildEngine();
    const result = engine.handle(
      request(DHCPREQUEST, { options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.200')]]) }),
      SERVER_ID,
    );
    expect(result).toBeNull();
  });

  it('stays silent for an in-pool address when the client has no prior binding (RFC 2131 §4.3.2)', () => {
    const engine = buildEngine();
    const result = engine.handle(
      request(DHCPREQUEST, {
        chaddr: 'cc:cc:cc:cc:cc:01',
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.10')]]),
      }),
      SERVER_ID,
    );
    expect(result).toBeNull();
  });

  it('ACKs an in-pool INIT-REBOOT for a reserved client with no prior lease (RFC 2131 §4.3.2)', () => {
    const mac = 'dd:dd:dd:dd:dd:01';
    const engine = buildEngine({ reservations: [{ mac, ip: '10.0.0.11' }] });
    const result = engine.handle(
      request(DHCPREQUEST, {
        chaddr: mac,
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.11')]]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(result!.reply).messageType).toBe(DHCPACK);
    expect(decodeReply(result!.reply).yiaddr).toBe('10.0.0.11');
  });

  it('ACKs a managed address the client already holds', () => {
    const engine = buildEngine();
    const mac = 'aa:aa:aa:aa:aa:09';
    const offered = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr;
    const ack = engine.handle(
      request(DHCPREQUEST, { chaddr: mac, options: new Map([[OPT_REQUESTED_IP, encodeIp(offered)]]) }),
      SERVER_ID,
    );
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(decodeReply(ack!.reply).yiaddr).toBe(offered);
  });
});

describe('DhcpEngine opt-50 DISCOVER stickiness (#13)', () => {
  it('honors a free, in-range, unreserved requested IP hint', () => {
    const engine = buildEngine();
    const offer = engine.handle(
      request(DHCPDISCOVER, {
        chaddr: 'aa:aa:aa:aa:aa:0a',
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.12')]]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.12');
  });

  it('lets a reservation win over the hint', () => {
    const engine = buildEngine({ reservations: [{ mac: 'aa:aa:aa:aa:aa:0b', ip: '10.0.0.11' }] });
    const offer = engine.handle(
      request(DHCPDISCOVER, {
        chaddr: 'aa:aa:aa:aa:aa:0b',
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.12')]]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.11');
  });

  it('ignores a hint held live by another MAC', () => {
    const engine = buildEngine();
    engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:aa:aa:aa:aa:01' }), SERVER_ID);
    const offer = engine.handle(
      request(DHCPDISCOVER, {
        chaddr: 'bb:bb:bb:bb:bb:01',
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.10')]]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(offer!.reply).yiaddr).not.toBe('10.0.0.10');
  });
});

describe('DhcpEngine siaddr default (B2)', () => {
  it('defaults siaddr to the server IP on a non-PXE OFFER and ACK', () => {
    const engine = buildEngine();
    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(reparseReply(offer!.reply).siaddr).toBe(SERVER_ID);

    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(reparseReply(ack!.reply).siaddr).toBe(SERVER_ID);
  });

  it('overrides siaddr with the TFTP server in PXE mode', () => {
    const engine = buildEngine({ tftpServer: '10.0.0.7', bootfile: 'default.kpxe' });
    const offer = engine.handle(
      request(DHCPDISCOVER, {
        options: new Map([[OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')]]),
      }),
      SERVER_ID,
    );
    expect(reparseReply(offer!.reply).siaddr).toBe('10.0.0.7');
  });

  it('leaves siaddr 0.0.0.0 on a NAK', () => {
    const engine = buildEngine();
    const nak = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('192.168.99.99')],
        ]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(nak!.reply).messageType).toBe(DHCPNAK);
    expect(reparseReply(nak!.reply).siaddr).toBe('0.0.0.0');
  });
});

describe('DhcpEngine pool network/broadcast exclusion (B5)', () => {
  it('skips only the subnet network and broadcast, not every .0/.255 octet', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.254', rangeEnd: '10.0.1.0' });
    const ips = ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02'].map(
      (mac) => decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr,
    );
    expect(ips).toEqual(['10.0.0.254', '10.0.1.0']);
  });
});

describe('DhcpEngine honors requested lease time (B4)', () => {
  it('grants a requested lease within bounds and scales T1/T2 from it', () => {
    const engine = buildEngine({ leaseTtlSeconds: 3600 });
    const offer = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: new Map([[OPT_LEASE_TIME, encodeUint32(200)]]) }), SERVER_ID)!
        .reply,
    );
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(200);
    expect(offer.options.get(OPT_RENEWAL_TIME)!.readUInt32BE(0)).toBe(50);
    expect(offer.options.get(OPT_REBINDING_TIME)!.readUInt32BE(0)).toBe(100);
  });

  it('floors a too-short requested lease to 120s', () => {
    const engine = buildEngine({ leaseTtlSeconds: 3600 });
    const offer = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: new Map([[OPT_LEASE_TIME, encodeUint32(60)]]) }), SERVER_ID)!
        .reply,
    );
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(120);
  });

  it('caps a too-long requested lease at the configured lease', () => {
    const engine = buildEngine({ leaseTtlSeconds: 3600 });
    const offer = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: new Map([[OPT_LEASE_TIME, encodeUint32(100000)]]) }), SERVER_ID)!
        .reply,
    );
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
  });

  it('grants the configured lease when no option 51 is present', () => {
    const engine = buildEngine({ leaseTtlSeconds: 3600 });
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
  });
});

describe('DhcpEngine persists the granted lease time (#28)', () => {
  it('persists expiresAt from the granted opt-51 lease, not the config default', async () => {
    const now = 1_000;
    const puts: LeaseRecord[] = [];
    const store: LeaseStore = {
      loadAll: async () => [],
      put: async (lease) => {
        puts.push(lease);
      },
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, store);

    const offer = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: new Map([[OPT_LEASE_TIME, encodeUint32(200)]]) }), SERVER_ID)!
        .reply,
    );
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(200);

    await Promise.resolve();

    expect(puts).toHaveLength(1);
    expect(puts[0].expiresAt).toBe(now + 200);
  });

  it('persists the config lease when the client sends no opt-51', async () => {
    const now = 1_000;
    const puts: LeaseRecord[] = [];
    const store: LeaseStore = {
      loadAll: async () => [],
      put: async (lease) => {
        puts.push(lease);
      },
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, store);

    engine.handle(request(DHCPDISCOVER), SERVER_ID);

    await Promise.resolve();

    expect(puts).toHaveLength(1);
    expect(puts[0].expiresAt).toBe(now + 3600);
  });
});

describe('DhcpEngine lease expiry without opt-51', () => {
  const mac = '00:0b:82:01:fc:42';

  function recordingStore(puts: LeaseRecord[]): LeaseStore {
    return {
      loadAll: async () => [],
      put: async (lease) => void puts.push(lease),
      delete: async () => {},
      pruneExpired: async () => 0,
      takeRevocations: async () => [],
    };
  }

  it('a re-DISCOVER without opt-51 keeps the prior expiry instead of resetting to max', async () => {
    let now = 1_000;
    const puts: LeaseRecord[] = [];
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, recordingStore(puts));

    const first = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply);
    expect(first.yiaddr).toBe('10.0.0.10');
    expect(first.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
    expect(puts[0].expiresAt).toBe(1_000 + 3600);

    now = 1_100;
    const second = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply);
    expect(second.yiaddr).toBe('10.0.0.10');
    expect(second.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3500);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(4_600);
  });

  it('a renewing REQUEST for its pool address renews the full lease from now', async () => {
    let now = 1_000;
    const puts: LeaseRecord[] = [];
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, recordingStore(puts));

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(puts[0].expiresAt).toBe(4_600);

    now = 1_500;
    const ack = decodeReply(
      engine.handle(request(DHCPREQUEST, { chaddr: mac, ciaddr: '10.0.0.10' }), SERVER_ID)!.reply,
    );
    expect(ack.messageType).toBe(DHCPACK);
    expect(ack.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
    expect(ack.options.get(OPT_RENEWAL_TIME)!.readUInt32BE(0)).toBe(900);
    expect(ack.options.get(OPT_REBINDING_TIME)!.readUInt32BE(0)).toBe(1800);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(5_100);
  });

  it('a SELECTING REQUEST after an OFFER grants the full lease', async () => {
    let now = 1_000;
    const puts: LeaseRecord[] = [];
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, recordingStore(puts));

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);

    now = 1_000.4;
    const ack = decodeReply(
      engine.handle(
        request(DHCPREQUEST, {
          chaddr: mac,
          options: new Map([
            [OPT_SERVER_ID, encodeIp(SERVER_ID)],
            [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
          ]),
        }),
        SERVER_ID,
      )!.reply,
    );
    expect(ack.messageType).toBe(DHCPACK);
    expect(ack.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(4_600);
  });

  it('a renewing REQUEST for its reservation renews the full lease from now', async () => {
    let now = 1_000;
    const puts: LeaseRecord[] = [];
    const engine = buildEngine(
      { leaseTtlSeconds: 3600, reservations: [{ mac, ip: '10.0.0.11' }] },
      () => now,
      recordingStore(puts),
    );

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(puts[0].ip).toBe('10.0.0.11');

    now = 2_000;
    const ack = decodeReply(
      engine.handle(request(DHCPREQUEST, { chaddr: mac, ciaddr: '10.0.0.11' }), SERVER_ID)!.reply,
    );
    expect(ack.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(5_600);
  });

  it('a renewal by a MAC holding an address reserved for another MAC keeps its expiry', async () => {
    let now = 1_000;
    const puts: LeaseRecord[] = [];
    const engine = buildEngine(
      {
        leaseTtlSeconds: 3600,
        rangeStart: '10.0.0.10',
        rangeEnd: '10.0.0.10',
        reservations: [{ mac: 'ee:ee:ee:ee:ee:01', ip: '10.0.0.10' }],
      },
      () => now,
      recordingStore(puts),
    );
    const dynMac = 'aa:aa:aa:aa:aa:01';
    engine.handle(request(DHCPREQUEST, { chaddr: dynMac, ciaddr: '10.0.0.10' }), SERVER_ID);
    expect(puts.at(-1)!.expiresAt).toBe(4_600);

    now = 2_000;
    const ack = decodeReply(
      engine.handle(request(DHCPREQUEST, { chaddr: dynMac, ciaddr: '10.0.0.10' }), SERVER_ID)!.reply,
    );
    expect(ack.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(2600);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(4_600);
  });

  it('a renewal of a held out-of-pool binding keeps its expiry so a narrowed pool drains', async () => {
    const now = 1_000;
    const puts: LeaseRecord[] = [];
    const store: LeaseStore = {
      ...recordingStore(puts),
      loadAll: async () => [{ ip: '10.0.0.200', mac, hostname: null, expiresAt: 2_000 }],
    };
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, store);
    await engine.hydrate();

    const ack = decodeReply(
      engine.handle(request(DHCPREQUEST, { chaddr: mac, ciaddr: '10.0.0.200' }), SERVER_ID)!.reply,
    );
    expect(ack.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(1000);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(2_000);
  });

  it('an explicit opt-51 still resets the lease from now', async () => {
    let now = 1_000;
    const puts: LeaseRecord[] = [];
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now, recordingStore(puts));

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);

    now = 1_100;
    const renewed = decodeReply(
      engine.handle(
        request(DHCPDISCOVER, { chaddr: mac, options: new Map([[OPT_LEASE_TIME, encodeUint32(1800)]]) }),
        SERVER_ID,
      )!.reply,
    );
    expect(renewed.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(1800);
    await Promise.resolve();
    expect(puts.at(-1)!.expiresAt).toBe(2_900);
  });

  it('clamps the wire opt-51 to ≥1s when a preserved binding has sub-second remaining', () => {
    let now = 1_000;
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now);

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);

    now = 4_599.5;
    const reoffer = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply);
    expect(reoffer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(1);
  });

  it('resets from now when the prior binding has genuinely expired', () => {
    let now = 1_000;
    const engine = buildEngine({ leaseTtlSeconds: 3600 }, () => now);

    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);

    now = 5_000;
    const reoffer = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply);
    expect(reoffer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(3600);
  });
});

describe('DhcpEngine reservation cannot steal a live lease (#4)', () => {
  it('refuses to OFFER a reserved IP that another MAC holds live', () => {
    const engine = buildEngine({
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.10',
      reservations: [{ mac: 'ee:ee:ee:ee:ee:01', ip: '10.0.0.10' }],
    });
    const dynMac = 'aa:aa:aa:aa:aa:01';
    const renew = engine.handle(request(DHCPREQUEST, { chaddr: dynMac, ciaddr: '10.0.0.10' }), SERVER_ID);
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPACK);
    expect(engine.leases().find((l) => l.ip === '10.0.0.10')?.mac).toBe(dynMac);

    const reservedOwner = engine.handle(request(DHCPDISCOVER, { chaddr: 'ee:ee:ee:ee:ee:01' }), SERVER_ID);
    expect(reservedOwner).toBeNull();
    expect(engine.leases().find((l) => l.ip === '10.0.0.10')?.mac).toBe(dynMac);
  });

  it('NAKs a SELECTING REQUEST for an address another MAC holds live', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.10' });
    const holder = 'aa:aa:aa:aa:aa:01';
    engine.handle(request(DHCPDISCOVER, { chaddr: holder }), SERVER_ID);
    const stealer = engine.handle(
      request(DHCPREQUEST, {
        chaddr: 'bb:bb:bb:bb:bb:01',
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(stealer!.reply).messageType).toBe(DHCPNAK);
    expect(engine.leases().find((l) => l.ip === '10.0.0.10')?.mac).toBe(holder);
  });
});

const PXE_VENDOR = new Map([[OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')]]);

function buildProxyEngine(overrides: Partial<SubnetConfig> = {}): DhcpEngine {
  return buildEngine({ mode: 'PROXY', tftpServer: '10.0.0.7', bootfile: 'pxelinux.0', ...overrides });
}

describe('DhcpEngine PROXY mode', () => {
  it('#1 OFFERs boot info on a :67 PXE DISCOVER with yiaddr 0 and the boot options', () => {
    const engine = buildProxyEngine();
    const offer = engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID);
    expect(offer).not.toBeNull();
    const decoded = decodeReply(offer!.reply);
    expect(decoded.messageType).toBe(DHCPOFFER);
    expect(decoded.yiaddr).toBe('0.0.0.0');
    expect(decoded.options.get(OPT_VENDOR_CLASS)!.toString('ascii')).toBe('PXEClient');
    expect(decoded.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.7');
    expect(asciiUntilNul(decoded.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');
    expect(reparseReply(offer!.reply).siaddr).toBe('10.0.0.7');
    expect(decodeIp(decoded.options.get(OPT_SERVER_ID)!)).toBe(SERVER_ID);
  });

  it('#2 emits opt-43 == Buffer([6, 1, 8, 0xff])', () => {
    const engine = buildProxyEngine();
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID)!.reply);
    expect(Buffer.from(offer.options.get(OPT_VENDOR_ENCAP)!)).toEqual(Buffer.from([6, 1, 8, 0xff]));
  });

  it('#3 omits the AUTHORITATIVE lease/subnet options (1/3/6/28/51/58/59)', () => {
    const engine = buildProxyEngine();
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID)!.reply);
    for (const code of [
      OPT_SUBNET_MASK,
      OPT_ROUTER,
      OPT_DNS_SERVERS,
      OPT_BROADCAST,
      OPT_LEASE_TIME,
      OPT_RENEWAL_TIME,
      OPT_REBINDING_TIME,
    ]) {
      expect(offer.options.has(code)).toBe(false);
    }
  });

  it('#4 never writes the lease map across a DISCOVER then a :4011 REQUEST', () => {
    const engine = buildProxyEngine();
    engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID);
    engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: PXE_VENDOR }), SERVER_ID, true);
    expect(engine.leases()).toHaveLength(0);
  });

  it('#5 stays silent for a non-PXE DISCOVER on :67', () => {
    const engine = buildProxyEngine();
    expect(engine.handle(request(DHCPDISCOVER), SERVER_ID)).toBeNull();
  });

  it('#6 stays silent for non-PXE REQUEST/INFORM/RELEASE/DECLINE and writes no lease', () => {
    const engine = buildProxyEngine();
    for (const type of [DHCPREQUEST, DHCPINFORM, DHCPRELEASE, DHCPDECLINE]) {
      expect(engine.handle(request(type), SERVER_ID)).toBeNull();
      expect(engine.handle(request(type), SERVER_ID, true)).toBeNull();
    }
    expect(engine.leases()).toHaveLength(0);
  });

  it('#7 ACKs boot info on a :4011 PXE REQUEST, unicast to ciaddr:4011', () => {
    const engine = buildProxyEngine();
    const ack = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: PXE_VENDOR }), SERVER_ID, true);
    expect(ack).not.toBeNull();
    const decoded = decodeReply(ack!.reply);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('0.0.0.0');
    expect(decoded.options.get(OPT_VENDOR_CLASS)!.toString('ascii')).toBe('PXEClient');
    expect(decoded.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.7');
    expect(asciiUntilNul(decoded.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');
    expect(Buffer.from(decoded.options.get(OPT_VENDOR_ENCAP)!)).toEqual(Buffer.from([6, 1, 8, 0xff]));
    expect(ack!.target).toEqual({ address: '10.0.0.50', port: 68 });
  });

  it('#8 :4011 ignores a non-PXE message AND a PXE DISCOVER (wrong port for OFFER)', () => {
    const engine = buildProxyEngine();
    expect(engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50' }), SERVER_ID, true)).toBeNull();
    expect(engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID, true)).toBeNull();
  });

  it('#9 :67 ignores a PXE REQUEST (boot-server REQUESTs belong on :4011)', () => {
    const engine = buildProxyEngine();
    expect(
      engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: PXE_VENDOR }), SERVER_ID, false),
    ).toBeNull();
  });

  it('#10 selects the arch-specific bootfile via option 93', () => {
    const engine = buildProxyEngine({ bootfileByArch: new Map([[7, 'ipxe.efi']]) });
    const arch = Buffer.alloc(2);
    arch.writeUInt16BE(7, 0);
    const offer = decodeReply(
      engine.handle(
        request(DHCPDISCOVER, {
          options: new Map([
            [OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00007', 'ascii')],
            [OPT_CLIENT_ARCH, arch],
          ]),
        }),
        SERVER_ID,
      )!.reply,
    );
    expect(asciiUntilNul(offer.options.get(OPT_BOOTFILE)!)).toBe('ipxe.efi');
  });

  it('#11 broadcasts the OFFER for a broadcast-flag DISCOVER', () => {
    const engine = buildProxyEngine();
    const offer = engine.handle(request(DHCPDISCOVER, { broadcast: true, options: PXE_VENDOR }), SERVER_ID);
    expect(offer!.target).toEqual({ address: LIMITED_BROADCAST, port: 68 });
  });

  it('#12 with no TFTP server: siaddr = server-id, opt-66 absent, opt-67 present', () => {
    const engine = buildProxyEngine({ tftpServer: '', bootfile: 'pxelinux.0' });
    const offer = engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID);
    const decoded = decodeReply(offer!.reply);
    expect(reparseReply(offer!.reply).siaddr).toBe(SERVER_ID);
    expect(decoded.options.has(OPT_TFTP_SERVER)).toBe(false);
    expect(asciiUntilNul(decoded.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');
  });

  it('PXE-12: suppresses opt-67 on a PROXY OFFER for an iPXE user-class (opt-77) request', () => {
    const engine = buildProxyEngine();
    const offer = decodeReply(
      engine.handle(
        request(DHCPDISCOVER, {
          options: new Map([
            [OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')],
            [OPT_USER_CLASS, Buffer.from('iPXE', 'ascii')],
          ]),
        }),
        SERVER_ID,
      )!.reply,
    );
    expect(offer.messageType).toBe(DHCPOFFER);
    expect(offer.options.has(OPT_BOOTFILE)).toBe(false);
    const firmware = decodeReply(engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID)!.reply);
    expect(asciiUntilNul(firmware.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');
  });
});

describe('DhcpEngine per-subnet PROXY MAC allowlist gate', () => {
  const ALLOWED_MAC = '00:0b:82:01:fc:42';
  const OTHER_MAC = 'aa:bb:cc:dd:ee:ff';

  function proxyEngineWithAllowlist(allowlist: Set<string> | undefined): DhcpEngine {
    return buildEngine({
      mode: 'PROXY',
      tftpServer: '10.0.0.7',
      bootfile: 'pxelinux.0',
      proxyAllowedMacs: allowlist,
    });
  }

  it('answers an allowlisted MAC on the :67 OFFER leg (handleProxy)', () => {
    const engine = proxyEngineWithAllowlist(new Set([ALLOWED_MAC]));
    const offer = engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).messageType).toBe(DHCPOFFER);
  });

  it('stays silent for a non-allowlisted MAC on the :67 OFFER leg (handleProxy)', () => {
    const engine = proxyEngineWithAllowlist(new Set([OTHER_MAC]));
    expect(engine.handle(request(DHCPDISCOVER, { options: PXE_VENDOR }), SERVER_ID)).toBeNull();
  });

  it('answers an allowlisted MAC on the :4011 ACK leg (handle PXE-port branch)', () => {
    const engine = proxyEngineWithAllowlist(new Set([ALLOWED_MAC]));
    const ack = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: PXE_VENDOR }), SERVER_ID, true);
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
  });

  it('stays silent for a non-allowlisted MAC on the :4011 ACK leg (handle PXE-port branch)', () => {
    const engine = proxyEngineWithAllowlist(new Set([OTHER_MAC]));
    expect(
      engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: PXE_VENDOR }), SERVER_ID, true),
    ).toBeNull();
  });

  it('undefined allowlist answers every MAC on both legs (feature off)', () => {
    const engine = proxyEngineWithAllowlist(undefined);
    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: OTHER_MAC, options: PXE_VENDOR }), SERVER_ID);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).messageType).toBe(DHCPOFFER);
    const ack = engine.handle(
      request(DHCPREQUEST, { chaddr: OTHER_MAC, ciaddr: '10.0.0.50', options: PXE_VENDOR }),
      SERVER_ID,
      true,
    );
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
  });

  it('no proxyAllowedMacs in subnet config answers every MAC (default)', () => {
    const engine = buildProxyEngine();
    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: OTHER_MAC, options: PXE_VENDOR }), SERVER_ID);
    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).messageType).toBe(DHCPOFFER);
  });

  it('empty (non-undefined) allowlist denies every MAC on both legs (deny-all)', () => {
    const engine = proxyEngineWithAllowlist(new Set<string>());
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: ALLOWED_MAC, options: PXE_VENDOR }), SERVER_ID)).toBeNull();
    expect(
      engine.handle(
        request(DHCPREQUEST, { chaddr: ALLOWED_MAC, ciaddr: '10.0.0.50', options: PXE_VENDOR }),
        SERVER_ID,
        true,
      ),
    ).toBeNull();
  });
});

describe('DhcpEngine PXE decision observer', () => {
  const LISTED_MAC = 'aa:aa:aa:aa:aa:aa';
  const UNLISTED_MAC = 'bb:bb:bb:bb:bb:bb';

  function observedProxyEngine(subnets: SubnetConfig[] = [proxySubnetConfig()]) {
    const decisions: Array<[string, PxeDecision]> = [];
    const engine = DhcpEngine.fromSubnets(
      { mode: 'PROXY', networks: subnets.length === 0 ? [] : [{ interfaceKey: 'eth0', subnets }] },
      undefined,
      undefined,
      undefined,
      { onDecision: (mac, decision) => decisions.push([mac, decision]) },
    );
    return { engine, decisions };
  }

  function proxySubnetConfig(): SubnetConfig {
    return makeSubnetConfig({
      tftpServer: '10.0.0.7',
      bootfile: 'pxelinux.0',
      proxyAllowedMacs: new Set([LISTED_MAC]),
    });
  }

  it('reports a refused-allowlist decision for an unlisted mac on the pxe port', () => {
    const { engine, decisions } = observedProxyEngine();

    const ack = engine.handle(
      request(DHCPREQUEST, { chaddr: UNLISTED_MAC, ciaddr: '10.0.0.50', options: PXE_VENDOR }),
      SERVER_ID,
      true,
    );

    expect(ack).toBeNull();
    expect(decisions).toEqual([[UNLISTED_MAC, 'refused-allowlist']]);
  });

  it('reports a refused-allowlist decision for an unlisted mac on the offer leg', () => {
    const { engine, decisions } = observedProxyEngine();

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: UNLISTED_MAC, options: PXE_VENDOR }), SERVER_ID);

    expect(offer).toBeNull();
    expect(decisions).toEqual([[UNLISTED_MAC, 'refused-allowlist']]);
  });

  it('reports an offered decision for a listed mac on both legs', () => {
    const { engine, decisions } = observedProxyEngine();

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: LISTED_MAC, options: PXE_VENDOR }), SERVER_ID);
    const ack = engine.handle(
      request(DHCPREQUEST, { chaddr: LISTED_MAC, ciaddr: '10.0.0.50', options: PXE_VENDOR }),
      SERVER_ID,
      true,
    );

    expect(offer).not.toBeNull();
    expect(decodeReply(offer!.reply).messageType).toBe(DHCPOFFER);
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
    expect(decisions).toEqual([
      [LISTED_MAC, 'offered'],
      [LISTED_MAC, 'offered'],
    ]);
  });

  it('reports a no-subnet decision when the engine holds no subnets', () => {
    const { engine, decisions } = observedProxyEngine([]);

    const ack = engine.handle(
      request(DHCPREQUEST, { chaddr: LISTED_MAC, ciaddr: '10.0.0.50', options: PXE_VENDOR }),
      SERVER_ID,
      true,
    );

    expect(ack).toBeNull();
    expect(decisions).toEqual([[LISTED_MAC, 'no-subnet']]);
  });

  it('reports nothing for a request without a pxe vendor class', () => {
    const { engine, decisions } = observedProxyEngine();

    engine.handle(request(DHCPDISCOVER, { chaddr: UNLISTED_MAC }), SERVER_ID);

    expect(decisions).toEqual([]);
  });
});

describe('DhcpEngine AUTHORITATIVE contract lock (#13)', () => {
  it('still allocates and writes a lease on a DISCOVER (PROXY branch must not regress it)', () => {
    const engine = buildEngine();
    const offer = engine.handle(request(DHCPDISCOVER), SERVER_ID);
    expect(decodeReply(offer!.reply).messageType).toBe(DHCPOFFER);
    expect(decodeReply(offer!.reply).yiaddr).toBe('10.0.0.10');
    expect(engine.leases()).toHaveLength(1);
    expect(engine.leases()[0].ip).toBe('10.0.0.10');
  });

  it('ignores the proxy MAC allowlist on the :4011 PXE ACK (allowlist is PROXY-only)', () => {
    const engine = buildEngine({
      tftpServer: '10.0.0.7',
      bootfile: 'pxelinux.0',
      proxyAllowedMacs: new Set(['aa:bb:cc:dd:ee:ff']),
    });
    const ack = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: PXE_VENDOR }), SERVER_ID, true);
    expect(ack).not.toBeNull();
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
  });
});

const FILE_FIELD_OFFSET = 108;
const SNAME_FIELD_OFFSET = 44;

function bootpFile(reply: Buffer): Buffer {
  return reply.subarray(FILE_FIELD_OFFSET, FILE_FIELD_OFFSET + 128);
}
function bootpSname(reply: Buffer): Buffer {
  return reply.subarray(SNAME_FIELD_OFFSET, SNAME_FIELD_OFFSET + 64);
}
function asciiUntilNul(field: Buffer): string {
  const nul = field.indexOf(0x00);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('ascii');
}
function prl(...codes: number[]): Map<number, Buffer> {
  return new Map([[OPT_PARAM_REQ_LIST, Buffer.from(codes)]]);
}

function countOption(reply: Buffer, code: number): number {
  let offset = 240;
  let count = 0;
  while (offset < reply.length) {
    const c = reply[offset];
    if (c === 0) {
      offset += 1;
      continue;
    }
    if (c === 0xff) break;
    const len = reply[offset + 1];
    if (c === code) count += 1;
    offset += 2 + len;
  }
  return count;
}

describe('DhcpEngine --dhcp-boot (authoritative boot params)', () => {
  it('15 — dormant (no DHCP_BOOT_* and no DHCP_PXE_*) → OFFER byte-identical to the golden', () => {
    const engine = buildEngine();
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;

    const golden = Buffer.alloc(548);
    golden[0] = 2;
    golden[1] = 0x01;
    golden[2] = 0x06;
    golden.writeUInt32BE(0x1234, 4);
    encodeIp('10.0.0.10').copy(golden, 16);
    encodeIp(SERVER_ID).copy(golden, 20);
    Buffer.from([0x00, 0x0b, 0x82, 0x01, 0xfc, 0x42]).copy(golden, 28);
    golden.writeUInt32BE(0x63825363, 236);
    Buffer.from([
      53,
      1,
      DHCPOFFER,
      54,
      4,
      10,
      0,
      0,
      1,
      1,
      4,
      255,
      255,
      255,
      0,
      28,
      4,
      10,
      0,
      0,
      255,
      3,
      4,
      10,
      0,
      0,
      1,
      6,
      4,
      10,
      0,
      0,
      1,
      51,
      4,
      0x00,
      0x00,
      0x0e,
      0x10,
      58,
      4,
      0x00,
      0x00,
      0x03,
      0x84,
      59,
      4,
      0x00,
      0x00,
      0x07,
      0x08,
      255,
    ]).copy(golden, 240);

    expect(reply).toEqual(golden);
  });

  it('16 — boot set + opt-55 omits 66&67 → BOOTP file/sname + siaddr, no opt-66/67', () => {
    const engine = buildEngine({
      bootBootfile: 'pxelinux.0',
      bootServerName: 'boot.lan',
      bootServerAddress: '10.0.0.7',
    });
    const reply = engine.handle(request(DHCPDISCOVER, { options: prl(1, 3, 6) }), SERVER_ID)!.reply;
    const decoded = decodeReply(reply);
    expect(asciiUntilNul(bootpFile(reply))).toBe('pxelinux.0');
    expect(asciiUntilNul(bootpSname(reply))).toBe('boot.lan');
    expect(reparseReply(reply).siaddr).toBe('10.0.0.7');
    expect(decoded.options.has(OPT_BOOTFILE)).toBe(false);
    expect(decoded.options.has(OPT_TFTP_SERVER)).toBe(false);
  });

  it('17 — opt-55 requests 67 → opt-67 emitted (no trailing NUL per RFC 2132 s2), BOOTP file field empty', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0' });
    const reply = engine.handle(request(DHCPDISCOVER, { options: prl(OPT_BOOTFILE) }), SERVER_ID)!.reply;
    const decoded = decodeReply(reply);
    expect(decoded.options.get(OPT_BOOTFILE)!).toEqual(
      Buffer.concat([Buffer.from('pxelinux.0', 'ascii'), Buffer.from([0])]),
    );
    expect(asciiUntilNul(bootpFile(reply))).toBe('');
  });

  it('18 — opt-55 requests 66 → opt-66 emitted (no trailing NUL per RFC 2132 s2), BOOTP sname field empty', () => {
    const engine = buildEngine({ bootServerName: 'boot.lan' });
    const reply = engine.handle(request(DHCPDISCOVER, { options: prl(OPT_TFTP_SERVER) }), SERVER_ID)!.reply;
    const decoded = decodeReply(reply);
    expect(decoded.options.get(OPT_TFTP_SERVER)!).toEqual(Buffer.from('boot.lan', 'ascii'));
    expect(asciiUntilNul(bootpSname(reply))).toBe('');
  });

  it('19 — opt-55 requests both 66 and 67 → both options emitted, both BOOTP fields empty', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0', bootServerName: 'boot.lan' });
    const reply = engine.handle(
      request(DHCPDISCOVER, { options: prl(OPT_TFTP_SERVER, OPT_BOOTFILE) }),
      SERVER_ID,
    )!.reply;
    const decoded = decodeReply(reply);
    expect(decoded.options.get(OPT_BOOTFILE)!).toEqual(
      Buffer.concat([Buffer.from('pxelinux.0', 'ascii'), Buffer.from([0])]),
    );
    expect(decoded.options.get(OPT_TFTP_SERVER)!).toEqual(Buffer.from('boot.lan', 'ascii'));
    expect(asciiUntilNul(bootpFile(reply))).toBe('');
    expect(asciiUntilNul(bootpSname(reply))).toBe('');
  });

  it('20 — bootServerAddress empty + bootfile set → siaddr stays serverId, not zeroed', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0' });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(reparseReply(reply).siaddr).toBe(SERVER_ID);
    expect(asciiUntilNul(bootpFile(reply))).toBe('pxelinux.0');
  });

  it('21 — a non-PXE client (no opt-60/93/97) still receives the boot fields (no PXE gate)', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0', bootServerAddress: '10.0.0.7' });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(asciiUntilNul(bootpFile(reply))).toBe('pxelinux.0');
    expect(reparseReply(reply).siaddr).toBe('10.0.0.7');
    expect(decodeReply(reply).options.has(OPT_VENDOR_CLASS)).toBe(false);
  });

  it('22 — a DHCPACK (REQUEST→ACK) carries the boot fields too', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0', bootServerAddress: '10.0.0.7' });
    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    )!.reply;
    expect(decodeReply(ack).messageType).toBe(DHCPACK);
    expect(asciiUntilNul(bootpFile(ack))).toBe('pxelinux.0');
    expect(reparseReply(ack).siaddr).toBe('10.0.0.7');
  });

  it('PXE-03 — an iPXE user-class (opt-77) DISCOVER drops the BOOTP file field, keeps siaddr/sname', () => {
    const engine = buildEngine({
      bootBootfile: 'snponly-amd64.efi',
      bootServerName: 'boot.lan',
      bootServerAddress: '10.0.0.7',
    });
    const reply = engine.handle(
      request(DHCPDISCOVER, { options: new Map([[OPT_USER_CLASS, Buffer.from('iPXE', 'ascii')]]) }),
      SERVER_ID,
    )!.reply;
    expect(asciiUntilNul(bootpFile(reply))).toBe('');
    expect(asciiUntilNul(bootpSname(reply))).toBe('boot.lan');
    expect(reparseReply(reply).siaddr).toBe('10.0.0.7');
  });

  it('PXE-03 — an iPXE user-class (opt-77) DISCOVER suppresses opt-67 even when the PRL requests it', () => {
    const engine = buildEngine({ bootBootfile: 'snponly-amd64.efi' });
    const reply = engine.handle(
      request(DHCPDISCOVER, {
        options: new Map<number, Buffer>([
          [OPT_PARAM_REQ_LIST, Buffer.from([OPT_BOOTFILE])],
          [OPT_USER_CLASS, Buffer.from('iPXE', 'ascii')],
        ]),
      }),
      SERVER_ID,
    )!.reply;
    expect(decodeReply(reply).options.has(OPT_BOOTFILE)).toBe(false);
    expect(asciiUntilNul(bootpFile(reply))).toBe('');
  });

  it('PXE-03 — a firmware (no opt-77) DISCOVER on the same config still gets the BOOTP file field', () => {
    const engine = buildEngine({ bootBootfile: 'snponly-amd64.efi' });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(asciiUntilNul(bootpFile(reply))).toBe('snponly-amd64.efi');
  });

  it('23 — opt-67 is NUL-terminated for UEFI PXE ROMs; opt-66 is not (ref beads local-sim-brpn)', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0', bootServerName: 'boot.lan' });
    const decoded = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: prl(OPT_TFTP_SERVER, OPT_BOOTFILE) }), SERVER_ID)!.reply,
    );
    const file67 = decoded.options.get(OPT_BOOTFILE)!;
    const name66 = decoded.options.get(OPT_TFTP_SERVER)!;
    expect(file67[file67.length - 1]).toBe(0x00);
    expect(file67.length).toBe('pxelinux.0'.length + 1);
    expect(asciiUntilNul(file67)).toBe('pxelinux.0');
    // opt-66 (TFTP-Server): unchanged, carries no trailing NUL.
    expect(name66[name66.length - 1]).not.toBe(0x00);
    expect(name66.toString('ascii')).toBe('boot.lan');
  });

  it('24 — the DHCP proxy path is unaffected (:67 OFFER and :4011 ACK: opt-43 06 01 08 ff, yiaddr 0)', () => {
    const engine = buildEngine({ mode: 'PROXY', tftpServer: '10.0.0.7', bootfile: 'pxelinux.0' });
    const pxeVendor = new Map([[OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')]]);

    const offer = decodeReply(engine.handle(request(DHCPDISCOVER, { options: pxeVendor }), SERVER_ID)!.reply);
    expect(offer.yiaddr).toBe('0.0.0.0');
    expect(Buffer.from(offer.options.get(OPT_VENDOR_ENCAP)!)).toEqual(Buffer.from([6, 1, 8, 0xff]));
    expect(offer.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.7');
    expect(asciiUntilNul(offer.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');

    const ackReply = engine.handle(request(DHCPREQUEST, { ciaddr: '10.0.0.50', options: pxeVendor }), SERVER_ID, true)!;
    const ack = decodeReply(ackReply.reply);
    expect(ack.messageType).toBe(DHCPACK);
    expect(ack.yiaddr).toBe('0.0.0.0');
    expect(Buffer.from(ack.options.get(OPT_VENDOR_ENCAP)!)).toEqual(Buffer.from([6, 1, 8, 0xff]));
    expect(ack.options.get(OPT_TFTP_SERVER)!.toString('ascii')).toBe('10.0.0.7');
    expect(asciiUntilNul(ack.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');
    expect(ackReply.target).toEqual({ address: '10.0.0.50', port: 68 });
  });

  it('25 — an INFORM ACK folds in PRL-requested dhcp-boot OPTIONS but never the file/sname fields', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0', bootServerName: 'boot.lan' });
    const ack = engine.handle(
      request(DHCPINFORM, { ciaddr: '10.0.0.50', options: prl(OPT_BOOTFILE, OPT_TFTP_SERVER) }),
      SERVER_ID,
    )!.reply;
    const decoded = decodeReply(ack);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('0.0.0.0');
    expect(decoded.options.has(OPT_LEASE_TIME)).toBe(false);
    expect(asciiUntilNul(decoded.options.get(OPT_BOOTFILE)!)).toBe('pxelinux.0');
    expect(asciiUntilNul(decoded.options.get(OPT_TFTP_SERVER)!)).toBe('boot.lan');
    expect(asciiUntilNul(bootpFile(ack))).toBe('');
    expect(asciiUntilNul(bootpSname(ack))).toBe('');
  });

  it('25b — an INFORM ACK omits a configured dhcp-boot field the PRL does not request', () => {
    const engine = buildEngine({ bootBootfile: 'pxelinux.0', bootServerName: 'boot.lan' });
    const ack = engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID)!.reply;
    const decoded = decodeReply(ack);
    expect(decoded.options.has(OPT_BOOTFILE)).toBe(false);
    expect(decoded.options.has(OPT_TFTP_SERVER)).toBe(false);
    expect(asciiUntilNul(bootpFile(ack))).toBe('');
    expect(asciiUntilNul(bootpSname(ack))).toBe('');
  });
});

const OPT_DOMAIN_SEARCH = 119;
function opt(code: number, value: Buffer, force = false): DhcpOptionSpec {
  return { code, value, force };
}

describe('DhcpEngine operator DHCP_OPTIONS (--dhcp-option)', () => {
  const dns = encodeIp('1.1.1.1');

  it('26 — non-force option emitted when the client PRL lists its code', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]))] });
    const decoded = decodeReply(
      engine.handle(request(DHCPDISCOVER, { options: prl(OPT_DOMAIN_SEARCH) }), SERVER_ID)!.reply,
    );
    expect(decoded.options.has(OPT_DOMAIN_SEARCH)).toBe(true);
  });

  it('27 — non-force option NOT emitted when a PRL omits its code', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]))] });
    const decoded = decodeReply(engine.handle(request(DHCPDISCOVER, { options: prl(1, 3, 6) }), SERVER_ID)!.reply);
    expect(decoded.options.has(OPT_DOMAIN_SEARCH)).toBe(false);
  });

  it('28 — force option emitted even when a PRL omits its code', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]), true)] });
    const decoded = decodeReply(engine.handle(request(DHCPDISCOVER, { options: prl(1, 3, 6) }), SERVER_ID)!.reply);
    expect(decoded.options.has(OPT_DOMAIN_SEARCH)).toBe(true);
  });

  it('29 — with no PRL present, every configured option is emitted', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]))] });
    const decoded = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decoded.options.has(OPT_DOMAIN_SEARCH)).toBe(true);
  });

  it('30 — the same gating applies on a DHCPACK as on the OFFER', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]), true)] });
    engine.handle(request(DHCPDISCOVER), SERVER_ID);
    const ack = engine.handle(
      request(DHCPREQUEST, {
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    )!.reply;
    const decoded = decodeReply(ack);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.options.has(OPT_DOMAIN_SEARCH)).toBe(true);
  });

  it('31 — operator opt-6 produces a single TLV with the operator value, suppressing the default', () => {
    const engine = buildEngine({ dnsServers: ['10.0.0.1'], dhcpOptions: [opt(OPT_DNS_SERVERS, dns)] });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(countOption(reply, OPT_DNS_SERVERS)).toBe(1);
    expect(decodeIp(decodeReply(reply).options.get(OPT_DNS_SERVERS)!)).toBe('1.1.1.1');
  });

  it('32 — operator opt-3 overrides the default router as a single TLV', () => {
    const engine = buildEngine({ routers: ['10.0.0.1'], dhcpOptions: [opt(OPT_ROUTER, encodeIp('10.0.0.254'))] });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(countOption(reply, OPT_ROUTER)).toBe(1);
    expect(decodeIp(decodeReply(reply).options.get(OPT_ROUTER)!)).toBe('10.0.0.254');
  });

  it('33 — an operator opt with no default emits exactly once', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]))] });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(countOption(reply, OPT_DOMAIN_SEARCH)).toBe(1);
  });

  it('34 — without an operator opt-6, the default opt-6 is still emitted (regression)', () => {
    const engine = buildEngine({ dnsServers: ['10.0.0.1'] });
    const decoded = decodeReply(engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply);
    expect(decodeIp(decoded.options.get(OPT_DNS_SERVERS)!)).toBe('10.0.0.1');
  });

  it('35 — dormant (no DHCP_OPTIONS) → OFFER byte-identical to the no-operator baseline', () => {
    const baseline = buildEngine().handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    const dormant = buildEngine({ dhcpOptions: [] }).handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(dormant).toEqual(baseline);
  });

  it('36 — DHCP proxy is unaffected by DHCP_OPTIONS (it owns a fixed reply)', () => {
    const engine = buildEngine({
      mode: 'PROXY',
      tftpServer: '10.0.0.7',
      bootfile: 'pxelinux.0',
      dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]), true)],
    });
    const pxeVendor = new Map([[OPT_VENDOR_CLASS, Buffer.from('PXEClient:Arch:00000', 'ascii')]]);
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER, { options: pxeVendor }), SERVER_ID)!.reply);
    expect(offer.options.has(OPT_DOMAIN_SEARCH)).toBe(false);
  });

  it('37 — a NAK carries no operator options', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x00]), true)] });
    const nak = engine.handle(request(DHCPREQUEST, { ciaddr: '192.168.99.99' }), SERVER_ID)!.reply;
    const decoded = decodeReply(nak);
    expect(decoded.messageType).toBe(DHCPNAK);
    expect(decoded.options.has(OPT_DOMAIN_SEARCH)).toBe(false);
  });

  it('38 — an INFORM ACK folds in a forced operator option, with no lease time or yiaddr', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x09]), true)] });
    const ack = engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID)!.reply;
    const decoded = decodeReply(ack);
    expect(decoded.messageType).toBe(DHCPACK);
    expect(decoded.yiaddr).toBe('0.0.0.0');
    expect(decoded.options.has(OPT_LEASE_TIME)).toBe(false);
    expect(decoded.options.get(OPT_DOMAIN_SEARCH)).toEqual(Buffer.from([0x09]));
    expect(countOption(ack, OPT_DOMAIN_SEARCH)).toBe(1);
  });

  it('38b — an INFORM ACK emits a non-force operator option only when the PRL lists its code', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.from([0x09]))] });
    const withoutPrl = decodeReply(engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50' }), SERVER_ID)!.reply);
    expect(withoutPrl.options.has(OPT_DOMAIN_SEARCH)).toBe(true);

    const omitted = decodeReply(
      engine.handle(request(DHCPINFORM, { ciaddr: '10.0.0.50', options: prl(1, 3, 6) }), SERVER_ID)!.reply,
    );
    expect(omitted.options.has(OPT_DOMAIN_SEARCH)).toBe(false);
  });

  it('48 — large 119+121 with a small opt-57 spills into the overload field and still round-trips', () => {
    const route121 = Buffer.alloc(100, 0x07);
    const engine = buildEngine({
      dhcpOptions: [opt(119, Buffer.alloc(200, 0x61), true), opt(121, route121, true)],
    });
    const opts = new Map([[OPT_MAX_MSG_SIZE, Buffer.from([0x02, 0x24])]]);
    const decoded = decodeReply(engine.handle(request(DHCPDISCOVER, { options: opts }), SERVER_ID)!.reply);
    expect(decoded.options.get(119)!.length).toBe(200);
    expect(decoded.options.get(121)!.equals(route121)).toBe(true);
  });

  it('49 — a 255-byte operator option emits as one TLV', () => {
    const engine = buildEngine({ dhcpOptions: [opt(OPT_DOMAIN_SEARCH, Buffer.alloc(255, 0x61), true)] });
    const reply = engine.handle(request(DHCPDISCOVER), SERVER_ID)!.reply;
    expect(countOption(reply, OPT_DOMAIN_SEARCH)).toBe(1);
    expect(decodeReply(reply).options.get(OPT_DOMAIN_SEARCH)!.length).toBe(255);
  });
});

function fixedStore(records: LeaseRecord[]): LeaseStore {
  return {
    loadAll: async () => records,
    put: async () => {},
    delete: async () => {},
    pruneExpired: async () => 0,
    takeRevocations: async () => [],
  };
}

describe('DhcpEngine lease-map desync (bugbot #6)', () => {
  it('does not OFFER a stale own-lease IP that another MAC now holds', async () => {
    const now = 1_000;
    const macA = 'aa:aa:aa:aa:aa:0a';
    const macB = 'bb:bb:bb:bb:bb:0b';
    const sharedIp = '10.0.0.11';
    const store = fixedStore([
      { ip: sharedIp, mac: macA, hostname: null, expiresAt: now + 3600 },
      { ip: sharedIp, mac: macB, hostname: null, expiresAt: now + 3600 },
    ]);
    const engine = buildEngine({}, () => now, store);
    await engine.hydrate();

    const offer = engine.handle(request(DHCPDISCOVER, { chaddr: macA }), SERVER_ID);
    expect(offer).not.toBeNull();
    const decoded = decodeReply(offer!.reply);
    expect(decoded.messageType).toBe(DHCPOFFER);
    expect(decoded.yiaddr).not.toBe(sharedIp);

    const ack = engine.handle(
      request(DHCPREQUEST, {
        chaddr: macA,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp(decoded.yiaddr)],
        ]),
      }),
      SERVER_ID,
    );
    expect(decodeReply(ack!.reply).messageType).toBe(DHCPACK);
  });
});

describe('DhcpEngine reserved-IP DECLINE-block/exclude gate (I7)', () => {
  it('drops a reserved MAC DISCOVER while its reserved IP is DECLINE-blocked, re-offering after backoff', () => {
    let now = 1000;
    const mac = '00:0b:82:01:fc:42';
    const reservedIp = '10.0.0.11';
    const engine = buildEngine({ reservations: [{ mac, ip: reservedIp }], declineBackoffSeconds: 600 }, () => now);

    expect(decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr).toBe(
      reservedIp,
    );
    engine.handle(
      request(DHCPDECLINE, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp(SERVER_ID)],
          [OPT_REQUESTED_IP, encodeIp(reservedIp)],
        ]),
      }),
      SERVER_ID,
    );

    expect(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)).toBeNull();

    now += 601;
    expect(decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)!.reply).yiaddr).toBe(
      reservedIp,
    );
  });

  it('drops a reserved MAC DISCOVER when its reserved IP is in excludeIps', () => {
    const mac = '00:0b:82:01:fc:42';
    const reservedIp = '10.0.0.11';
    const engine = buildEngine({ reservations: [{ mac, ip: reservedIp }], excludeIps: [reservedIp] });
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID)).toBeNull();
  });
});

describe('DhcpEngine DECLINE without opt-54 (I8)', () => {
  it('blocks and forgets a DECLINE that omits opt-54 (mirrors broadcast RELEASE)', () => {
    const engine = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.10', declineBackoffSeconds: 0 });
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    expect(engine.leases()).toHaveLength(1);

    engine.handle(
      request(DHCPDECLINE, {
        chaddr: mac,
        options: new Map([[OPT_REQUESTED_IP, encodeIp('10.0.0.10')]]),
      }),
      SERVER_ID,
    );
    expect(engine.leases()).toHaveLength(0);
    expect(engine.handle(request(DHCPDISCOVER, { chaddr: 'cc:cc:cc:cc:cc:cc' }), SERVER_ID)).toBeNull();
  });

  it('still ignores a DECLINE naming a DIFFERENT server in opt-54', () => {
    const engine = buildEngine();
    const mac = '00:0b:82:01:fc:42';
    engine.handle(request(DHCPDISCOVER, { chaddr: mac }), SERVER_ID);
    engine.handle(
      request(DHCPDECLINE, {
        chaddr: mac,
        options: new Map([
          [OPT_SERVER_ID, encodeIp('10.0.0.99')],
          [OPT_REQUESTED_IP, encodeIp('10.0.0.10')],
        ]),
      }),
      SERVER_ID,
    );
    expect(engine.leases()).toHaveLength(1);
  });
});

describe('DhcpEngine RENEWING out-of-pool block/exclude gate (I8)', () => {
  it('ACKs a renewal of a held out-of-pool ciaddr (baseline self-heal, no gate tripped)', async () => {
    const mac = '00:0b:82:01:fc:42';
    const heldIp = '10.0.0.200';
    const store = fixedStore([{ ip: heldIp, mac, hostname: null, expiresAt: 1e12 }]);
    const engine = buildEngine({}, undefined, store);
    await engine.hydrate();
    const renew = engine.handle(request(DHCPREQUEST, { chaddr: mac, ciaddr: heldIp }), SERVER_ID);
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPACK);
    expect(decodeReply(renew!.reply).yiaddr).toBe(heldIp);
  });

  it('NAKs a renewal of a held out-of-pool ciaddr that is in excludeIps', async () => {
    const mac = '00:0b:82:01:fc:42';
    const heldIp = '10.0.0.200';
    const store = fixedStore([{ ip: heldIp, mac, hostname: null, expiresAt: 1e12 }]);
    const engine = buildEngine({ excludeIps: [heldIp] }, undefined, store);
    await engine.hydrate();
    const renew = engine.handle(request(DHCPREQUEST, { chaddr: mac, ciaddr: heldIp }), SERVER_ID);
    expect(decodeReply(renew!.reply).messageType).toBe(DHCPNAK);
  });
});

describe('DhcpEngine per-subnet mode (mixed AUTHORITATIVE + PROXY)', () => {
  it('AUTHORITATIVE subnet leases while PROXY subnet only PXE-boots', () => {
    const authSubnet = makeSubnetConfig({
      mode: 'AUTHORITATIVE',
      rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.20',
      tftpServer: '10.0.0.7',
      bootfile: 'snponly-amd64.efi',
      bootfileByArch: new Map([[0x0007, 'snponly-amd64.efi']]),
    });
    const proxySubnet = makeSubnetConfig({
      mode: 'PROXY',
      serverId: '10.0.1.1',
      subnetMask: '255.255.255.0',
      rangeStart: '10.0.1.10',
      rangeEnd: '10.0.1.20',
      tftpServer: '10.0.1.7',
      bootfile: 'snponly-amd64.efi',
      bootfileByArch: new Map([[0x0007, 'snponly-amd64.efi']]),
    });
    const engine = DhcpEngine.fromSubnets({
      mode: 'AUTHORITATIVE',
      networks: [
        { interfaceKey: 'eth0', subnets: [authSubnet] },
        { interfaceKey: 'eth1', subnets: [proxySubnet] },
      ],
    });

    const discoverResult = engine.handle(request(DHCPDISCOVER), SERVER_ID, false, { ifindex: 1, ifname: 'eth0' });
    expect(discoverResult).not.toBeNull();
    const decoded = decodeReply(discoverResult!.reply);
    expect(decoded.messageType).toBe(DHCPOFFER);
    expect(decoded.yiaddr).not.toBe('0.0.0.0');

    expect(engine.servesPxeBoot()).toBe(true);
  });
});

describe('DhcpEngine.seedDeclinesFrom (hot-swap decline preservation)', () => {
  const now = () => 1_000_000;

  it('re-homes decline backoffs from a prior engine into the containing subnet of a fresh one', () => {
    const old = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.50', declineBackoffSeconds: 600 }, now);
    old.getSubnets()[0].block('10.0.0.20');
    expect(old.getSubnets()[0].isBlocked('10.0.0.20')).toBe(true);

    const fresh = buildEngine({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.50', declineBackoffSeconds: 600 }, now);
    expect(fresh.getSubnets()[0].isBlocked('10.0.0.20')).toBe(false);

    fresh.seedDeclinesFrom(old);
    expect(fresh.getSubnets()[0].isBlocked('10.0.0.20')).toBe(true);
  });

  it('drops a decline whose IP no longer maps into any subnet of the new engine', () => {
    const old = buildEngine({ declineBackoffSeconds: 600 }, now);
    old.getSubnets()[0].block('10.0.0.20');

    const fresh = buildEngine({ serverId: '192.168.5.1', rangeStart: '192.168.5.10', rangeEnd: '192.168.5.50' }, now);
    fresh.seedDeclinesFrom(old);
    expect(fresh.getSubnets()[0].isBlocked('10.0.0.20')).toBe(false);
  });

  it('re-homes a decline into EVERY containing subnet, not just the first match', () => {
    const build = (): DhcpEngine =>
      DhcpEngine.fromSubnets(
        {
          mode: 'AUTHORITATIVE',
          networks: [
            {
              interfaceKey: 'eth0',
              subnets: [
                makeSubnetConfig({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.12' }),
                makeSubnetConfig({ rangeStart: '10.0.0.20', rangeEnd: '10.0.0.22' }),
              ],
            },
          ],
        },
        now,
      );

    const old = build();
    expect(old.getSubnets().length).toBe(2);
    old.getSubnets()[1].block('10.0.0.21');

    const fresh = build();
    fresh.seedDeclinesFrom(old);

    expect(fresh.getSubnets().every((s) => s.isBlocked('10.0.0.21'))).toBe(true);
  });

  it('keeps the furthest-future expiry when sibling subnets diverge (no last-write clobber)', () => {
    const build = (): DhcpEngine =>
      DhcpEngine.fromSubnets(
        {
          mode: 'AUTHORITATIVE',
          networks: [
            {
              interfaceKey: 'eth0',
              subnets: [
                makeSubnetConfig({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.12' }),
                makeSubnetConfig({ rangeStart: '10.0.0.20', rangeEnd: '10.0.0.22' }),
              ],
            },
          ],
        },
        now,
      );

    const fresher = now() + 900_000;
    const staler = now() + 100_000;
    const old = build();
    old.getSubnets()[0].blockedUntil.set('10.0.0.21', fresher);
    old.getSubnets()[1].blockedUntil.set('10.0.0.21', staler);

    const fresh = build();
    fresh.seedDeclinesFrom(old);

    for (const s of fresh.getSubnets()) {
      expect(s.blockedUntil.get('10.0.0.21')).toBe(fresher);
    }
  });
});
