import { parse as loadYaml, YAMLParseError } from 'yaml';

import { intToIpv4, ipv4ToInt, isRecord } from '@repo/utils';

import { pythonFalsy } from '../saga-framework/truthiness';

const IPV4_MAX = 0xffffffff;
const SECTIONS = ['ethernets', 'bonds', 'vlans'] as const;

export interface Ipv4Address {
  readonly ip: string;
  readonly packedInt: number;
}

export function extractStaticAddresses(netplanYaml: unknown): Ipv4Address[] {
  if (!netplanYaml || typeof netplanYaml !== 'string') return [];

  let config: unknown;
  try {
    config = loadYaml(netplanYaml) ?? {};
  } catch (error) {
    if (error instanceof YAMLParseError) return [];
    throw error;
  }

  const network = isRecord(config) ? networkValue(config) : {};

  const addresses: Ipv4Address[] = [];
  for (const section of SECTIONS) {
    const ifaces = sectionValue(network, section);
    for (const ifaceConfig of objectValues(ifaces)) {
      if (!isRecord(ifaceConfig)) continue;
      const rawAddresses = 'addresses' in ifaceConfig ? ifaceConfig.addresses : [];
      const ifaceAddresses = pythonFalsy(rawAddresses) ? [] : rawAddresses;
      for (const addr of toIterable(ifaceAddresses)) {
        const parsed = parseIpv4Interface(addr);
        if (parsed !== null) addresses.push(parsed);
      }
    }
  }
  return addresses;
}

export const netplanAddressExtractor = {
  extract(netplanYaml: string): string[] {
    return extractStaticAddresses(netplanYaml).map((a) => a.ip);
  },
};

function networkValue(config: Record<string, unknown>): unknown {
  return 'network' in config ? config.network : {};
}

function sectionValue(network: unknown, section: string): unknown {
  if (!isRecord(network)) {
    throw new TypeError(`netplan 'network' is not a mapping: ${describe(network)}`);
  }
  const value = section in network ? network[section] : {};
  return pythonFalsy(value) ? {} : value;
}

function objectValues(ifaces: unknown): unknown[] {
  if (!isRecord(ifaces)) {
    throw new TypeError(`netplan interface section is not a mapping: ${describe(ifaces)}`);
  }
  return Object.values(ifaces);
}

function parseIpv4Interface(addr: unknown): Ipv4Address | null {
  if (typeof addr === 'number') return fromPackedInt(addr);
  if (typeof addr !== 'string') return null;
  return fromCidrString(addr);
}

function fromPackedInt(value: number): Ipv4Address | null {
  if (!Number.isInteger(value) || value < 0 || value > IPV4_MAX) return null;
  return { ip: intToIpv4(value), packedInt: value };
}

function fromCidrString(addr: string): Ipv4Address | null {
  if (addr.indexOf('/') !== addr.lastIndexOf('/')) return null;
  const slash = addr.indexOf('/');
  const host = slash === -1 ? addr : addr.slice(0, slash);
  if (slash !== -1 && !isNetmask(addr.slice(slash + 1))) return null;
  const packedInt = ipv4ToInt(host);
  if (packedInt === null) return null;
  return { ip: intToIpv4(packedInt), packedInt };
}

function isNetmask(value: string): boolean {
  if (/^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    return n >= 0 && n <= 32;
  }
  const ipInt = ipv4ToInt(value);
  if (ipInt === null) return false;
  return isContiguousMask(ipInt) || isContiguousMask((~ipInt >>> 0) >>> 0);
}

function isContiguousMask(ipInt: number): boolean {
  const inverted = (~ipInt >>> 0) >>> 0;
  return (inverted & (inverted + 1)) >>> 0 ? false : true;
}

function toIterable(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.keys(value);
  if (typeof value === 'string') return [];
  throw new TypeError(`netplan 'addresses' is not iterable: ${describe(value)}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  return typeof value;
}
