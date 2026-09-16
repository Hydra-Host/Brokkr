import { intToIpv4, ipv4ToInt } from '@repo/utils';

import { type KnownOption, encodeClasslessRoutes, encodeDomainSearch, knownOption } from './dhcp-option-encoders.js';
import { encodeIp } from './dhcp-options.js';

export const DEFAULT_DECLINE_BACKOFF_SECONDS = 600;
export const DEFAULT_LEADER_POLL_MS = 2000;
export const DEFAULT_PRUNE_INTERVAL_MS = 60000;

export const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const LEASE_MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){0,15}$/;

export type DhcpMode = 'AUTHORITATIVE' | 'PROXY' | 'OFF';

export interface DhcpReservation {
  mac: string;
  ip: string;
  // Per-device iPXE bootfile override from the reservation's ipxeBuildTarget; when absent
  // the engine serves the subnet-level bootfile.
  bootfile?: string;
  bootfileByArch?: Map<number, string>;
}

export interface DhcpOptionSpec {
  code: number;
  value: Buffer;
  force: boolean;
}

// Runtime tuning delivered via the zone-global `config:dhcp` hub atom; service policy
// (mode, pool, boot, DNS) comes from the per-prefix atoms.
export interface DhcpRuntimeConfig {
  leaderPollMs: number;
  pruneIntervalMs: number;
  declineBackoffSeconds: number;
}

/** Baseline used until the zone's `config:dhcp` ops atom arrives. */
export function defaultDhcpRuntimeConfig(): DhcpRuntimeConfig {
  return {
    leaderPollMs: DEFAULT_LEADER_POLL_MS,
    pruneIntervalMs: DEFAULT_PRUNE_INTERVAL_MS,
    declineBackoffSeconds: DEFAULT_DECLINE_BACKOFF_SECONDS,
  };
}

export function assertIpv4(name: string, value: string): string {
  const m = IPV4_RE.exec(value);
  if (
    !m ||
    m.slice(1).some((octet) => {
      const n = Number.parseInt(octet, 10);
      return n > 255 || String(n) !== octet;
    })
  ) {
    throw new Error(`Invalid ${name} environment variable: ${JSON.stringify(value)} (must be a dotted-quad IPv4)`);
  }
  return value;
}

// the lease/pool arithmetic downstream is total over `number`; a malformed address is a bug
// upstream, so fail loudly here rather than silently anchoring a subnet on 0.0.0.0.
export function ipToInt(ip: string): number {
  const value = ipv4ToInt(ip);
  if (value === null) throw new TypeError(`not a dotted-quad IPv4 address: ${JSON.stringify(ip)}`);
  return value;
}

export const intToIp = intToIpv4;

const DEC_WIDTH_4_THRESHOLD = 0xffff;
const DEC_WIDTH_2_THRESHOLD = 0xff;
const HEX_BYTE_RE = /^[0-9a-f]{1,2}(:[0-9a-f]{1,2})+$/i;
const DEC_RE = /^\d+[bsi]?$/;
const IPV4_SLASH_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d+$/;

export function parseDhcpOptionValue(code: number, tokens: string[]): Buffer {
  if (tokens.length === 0) {
    throw new Error(`DHCP_OPTIONS option ${code} has no value`);
  }
  const known = knownOption(code);

  if (known.kind === 'ADDR_LIST') {
    return encodeAddressList(code, tokens);
  }
  if (known.kind === 'RFC1035_NAME') {
    return encodeDomainSearch(tokens);
  }
  if (known.kind === 'NAME') {
    return encodeOptionString(code, tokens);
  }

  if (tokens.length === 1) {
    const token = tokens[0];
    if (HEX_BYTE_RE.test(token)) {
      return Buffer.from(token.split(':').map((h) => Number.parseInt(h, 16)));
    }
    if (DEC_RE.test(token)) {
      return encodeDecimal(code, token, known);
    }
  }

  if (tokens.some((t) => IPV4_SLASH_RE.test(t))) {
    return encodeClasslessRoutes(tokens);
  }
  if (tokens.every((t) => IPV4_RE.test(t))) {
    return encodeAddressList(code, tokens);
  }

  return encodeOptionString(code, tokens);
}

function encodeAddressList(code: number, tokens: string[]): Buffer {
  for (const token of tokens) {
    if (!IPV4_RE.test(token)) {
      throw new Error(`DHCP_OPTIONS option ${code} expects IPv4 addresses, got ${JSON.stringify(token)}`);
    }
  }
  return Buffer.concat(tokens.map(encodeIp));
}

function encodeDecimal(code: number, token: string, known: KnownOption): Buffer {
  let width: 1 | 2 | 4;
  let digits = token;
  const suffix = token.at(-1);
  if (suffix === 'b' || suffix === 's' || suffix === 'i') {
    width = suffix === 'b' ? 1 : suffix === 's' ? 2 : 4;
    digits = token.slice(0, -1);
  } else if (known.width !== 0) {
    width = known.width;
  } else {
    const magnitude = Number(digits);
    width = magnitude > DEC_WIDTH_4_THRESHOLD ? 4 : magnitude > DEC_WIDTH_2_THRESHOLD ? 2 : 1;
  }

  const value = Number.parseInt(digits, 10);
  const max = width === 1 ? 0xff : width === 2 ? 0xffff : 0xffffffff;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`DHCP_OPTIONS option ${code} value ${token} does not fit ${width} byte(s)`);
  }
  const buf = Buffer.alloc(width);
  buf.writeUIntBE(value, 0, width);
  return buf;
}

function encodeOptionString(code: number, tokens: string[]): Buffer {
  const text = tokens.join(',');
  if (text.includes('\0')) {
    throw new Error(`DHCP_OPTIONS option ${code} string value must not contain a NUL byte`);
  }
  return Buffer.from(text, 'ascii');
}
