import { describe, expect, it, vi } from 'vitest';

import type { NetworkInterface } from '../../bridge-network/self-network.js';
import { mapAtomsToEngine } from '../dhcp-atom-mapper';
import type { DhcpAtomValue } from '../dhcp-atom-value.schema';
import { DhcpConfigReaderService } from '../dhcp-config-reader.service';
import {
  DHCPDISCOVER,
  DHCPOFFER,
  OPT_DNS_SERVERS,
  OPT_LEASE_TIME,
  OPT_REBINDING_TIME,
  OPT_RENEWAL_TIME,
  OPT_ROUTER,
  OPT_SERVER_ID,
  OPT_SUBNET_MASK,
  decodeIp,
} from '../dhcp-options.js';
import { DhcpEngine } from '../dhcp-server.js';
import { parsePacket } from '../protocol.js';
import { makeAtom, makeLogger, okEnvelope, request } from './test-factories.js';

const SERVER_ID = '10.0.1.5';
const IFACES: NetworkInterface[] = [
  {
    name: 'eth0',
    ip: SERVER_ID,
    netmask: '255.255.255.0',
    prefix: 24,
    network: '10.0.1.0/24',
    isPrimary: true,
    interfaceType: 'physical',
  },
];

function atom(overrides: Partial<DhcpAtomValue> = {}): DhcpAtomValue {
  return makeAtom({
    dnsServers: ['10.0.1.53'],
    leaseTtlSeconds: 600,
    nextServer: SERVER_ID,
    ...overrides,
  });
}

function makeRedis(store: Map<string, string>) {
  return {
    scan: vi.fn(async () => [...store.keys()]),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

function createReader(store: Map<string, string>): DhcpConfigReaderService {
  return new DhcpConfigReaderService(makeRedis(store) as never, makeLogger() as never);
}

interface DecodedReply {
  messageType: number;
  yiaddr: string;
  siaddr: string;
  options: Map<number, Buffer>;
}

function decodeReply(reply: Buffer): DecodedReply {
  const copy = Buffer.from(reply);
  copy[0] = 1;
  const parsed = parsePacket(copy);
  return { messageType: parsed.messageType!, yiaddr: parsed.yiaddr, siaddr: parsed.siaddr, options: parsed.options };
}

function engineFromConfigs(configs: Map<string, DhcpAtomValue>): DhcpEngine {
  const mapping = mapAtomsToEngine(configs, IFACES, { warn: vi.fn() });
  let mode: DhcpAtomValue['mode'] = 'AUTHORITATIVE';
  for (const a of configs.values()) {
    if (a.mode !== 'OFF') {
      mode = a.mode;
      break;
    }
  }
  return DhcpEngine.fromSubnets({ mode, networks: mapping.networks, relayed: mapping.relayed });
}

async function readConfigs(store: Map<string, string>): Promise<Map<string, DhcpAtomValue>> {
  const result = await createReader(store).readAll();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('reader returned ok:false');
  return result.configs;
}

const KEY = 'prefix:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:config:dhcp';

describe('DHCP hub-atom -> bridge live-apply (e2e)', () => {
  it('serves a hub-written atom end to end: bytes -> reader -> mapper -> engine -> OFFER', async () => {
    const store = new Map([[KEY, okEnvelope(atom())]]);
    const configs = await readConfigs(store);
    expect(configs.size).toBe(1);

    const engine = engineFromConfigs(configs);
    const reply = engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:bb:cc:dd:ee:01' }), SERVER_ID);
    expect(reply).not.toBeNull();

    const offer = decodeReply(reply!.reply);
    expect(offer.messageType).toBe(DHCPOFFER);
    expect(offer.yiaddr).toBe('10.0.1.100');
    expect(decodeIp(offer.options.get(OPT_SERVER_ID)!)).toBe(SERVER_ID);
    expect(decodeIp(offer.options.get(OPT_SUBNET_MASK)!)).toBe('255.255.255.0');
    expect(decodeIp(offer.options.get(OPT_ROUTER)!)).toBe('10.0.1.1');
    expect(decodeIp(offer.options.get(OPT_DNS_SERVERS)!)).toBe('10.0.1.53');
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(600);
    expect(offer.options.get(OPT_RENEWAL_TIME)!.readUInt32BE(0)).toBe(150);
    expect(offer.options.get(OPT_REBINDING_TIME)!.readUInt32BE(0)).toBe(300);
    expect(offer.siaddr).toBe(SERVER_ID);
  });

  it('live-applies a rewritten atom: new router + pool reflected in the OFFER after re-read', async () => {
    const store = new Map([[KEY, okEnvelope(atom())]]);

    const engine1 = engineFromConfigs(await readConfigs(store));
    const offer1 = decodeReply(
      engine1.handle(request(DHCPDISCOVER, { chaddr: 'aa:bb:cc:dd:ee:02' }), SERVER_ID)!.reply,
    );
    expect(decodeIp(offer1.options.get(OPT_ROUTER)!)).toBe('10.0.1.1');
    expect(offer1.yiaddr).toBe('10.0.1.100');

    store.set(KEY, okEnvelope(atom({ routers: ['10.0.1.254'], pools: [{ start: '10.0.1.50', end: '10.0.1.60' }] })));

    const engine2 = engineFromConfigs(await readConfigs(store));
    const offer2 = decodeReply(
      engine2.handle(request(DHCPDISCOVER, { chaddr: 'aa:bb:cc:dd:ee:03' }), SERVER_ID)!.reply,
    );
    expect(decodeIp(offer2.options.get(OPT_ROUTER)!)).toBe('10.0.1.254');
    expect(offer2.yiaddr).toBe('10.0.1.50');
  });

  it('derives Kea renewal/rebinding timers from the atom lease TTL (not a hardcoded 150/300)', async () => {
    const store = new Map([[KEY, okEnvelope(atom({ leaseTtlSeconds: 1200 }))]]);
    const engine = engineFromConfigs(await readConfigs(store));
    const offer = decodeReply(engine.handle(request(DHCPDISCOVER, { chaddr: 'aa:bb:cc:dd:ee:04' }), SERVER_ID)!.reply);
    expect(offer.options.get(OPT_LEASE_TIME)!.readUInt32BE(0)).toBe(1200);
    expect(offer.options.get(OPT_RENEWAL_TIME)!.readUInt32BE(0)).toBe(300);
    expect(offer.options.get(OPT_REBINDING_TIME)!.readUInt32BE(0)).toBe(600);
  });
});
