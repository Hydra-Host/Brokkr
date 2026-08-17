import { vi } from 'vitest';

import type { NetworkInterface } from '../../bridge-network/self-network.js';
import type { DhcpAtomValue } from '../dhcp-atom-value.schema.js';
import type { DhcpRuntimeConfig } from '../dhcp.config.js';
export type { NetworkInterface } from '../../bridge-network/self-network.js';
export type { DhcpAtomValue } from '../dhcp-atom-value.schema.js';
export type { DhcpRuntimeConfig } from '../dhcp.config.js';

export const POLL_MS = 50;

export function makeRuntimeConfig(overrides: Partial<DhcpRuntimeConfig> = {}): DhcpRuntimeConfig {
  return {
    leaderPollMs: POLL_MS,
    pruneIntervalMs: 60000,
    declineBackoffSeconds: 600,
    ...overrides,
  };
}

export function makeAtom(overrides: Partial<DhcpAtomValue> = {}): DhcpAtomValue {
  return {
    mode: 'AUTHORITATIVE',
    subnet: '10.0.1.0/24',
    pools: [{ start: '10.0.1.100', end: '10.0.1.200' }],
    routers: ['10.0.1.1'],
    dnsServers: [],
    leaseTtlSeconds: 3600,
    reservations: [],
    proxyPeerAuthoritative: false,
    dhcpOptions: [],
    nextServer: null,
    ipxeBuildTarget: null,
    relay: null,
    proxyAllowedMacs: [],
    ...overrides,
  };
}

export function iface(name: string, ip: string): NetworkInterface {
  return {
    name,
    ip,
    netmask: '255.255.255.0',
    prefix: 24,
    network: `${ip.split('.').slice(0, 3).join('.')}.0/24`,
    isPrimary: true,
    interfaceType: 'physical',
  };
}

export function makeIface(overrides: Partial<NetworkInterface> = {}): NetworkInterface {
  const ip = overrides.ip ?? '10.0.1.5';
  return {
    name: 'eth0',
    ip,
    netmask: '255.255.255.0',
    prefix: 24,
    network: `${ip.split('.').slice(0, 3).join('.')}.0/24`,
    isPrimary: true,
    interfaceType: 'physical',
    ...overrides,
  };
}

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setBroadcast: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

export function makeFakeSocket(): FakeSocket {
  return {
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    bind: vi.fn((_port: number, _ip: string, cb: () => void) => cb()),
    send: vi.fn(),
    setBroadcast: vi.fn(),
    close: vi.fn(),
  };
}

/** Wrap a DhcpAtomValue in the envelope shape the hub ConfigAtomWriter SETs in Redis. */
export function okEnvelope(value: DhcpAtomValue, writtenAt = 0): string {
  return JSON.stringify({ status: 'ok', value, written_at: writtenAt, request_id: null });
}

/** Stub logger satisfying the { debug, info, warning, error } shape used by DHCP services. */
export function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
}

/** Stub logger satisfying the { warn } shape used by AtomMapperLogger. */
export function silentLogger(): { warn: ReturnType<typeof vi.fn<(message: string) => void>> } {
  return { warn: vi.fn<(message: string) => void>() };
}

/** Minimal valid DhcpMessage for use in engine/mapper tests. */
export function request(
  messageType: number,
  overrides: Partial<{
    op: number;
    htype: number;
    hlen: number;
    hops: number;
    xid: number;
    secs: number;
    flags: number;
    broadcast: boolean;
    ciaddr: string;
    yiaddr: string;
    siaddr: string;
    giaddr: string;
    chaddr: string;
    options: Map<number, Buffer>;
  }> = {},
) {
  return {
    op: 1,
    htype: 1,
    hlen: 6,
    hops: 0,
    xid: 0x1234,
    secs: 0,
    flags: 0,
    broadcast: false,
    ciaddr: '0.0.0.0',
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    chaddr: '00:0b:82:01:fc:42',
    messageType,
    options: new Map<number, Buffer>(),
    ...overrides,
  };
}
