import { isIP } from 'node:net';

import { isRecord } from '@repo/utils';
import { isClientFacingName } from '../../bridge-network/bridge-ip-resolution.service';
import { isRoutableUnicastIpv4 } from '../../bridge-network/ip-utils';
import type { BridgeSnapshot, InterfaceEntry } from './topology-broadcaster.types';

interface ParsedAddress {
  version: 4 | 6;
  value: bigint;
}

interface ParsedNetwork {
  version: 4 | 6;
  network: bigint;
  prefix: number;
  totalBits: number;
}

export function parseAddress(addr: string): ParsedAddress | null {
  const family = isIP(addr);
  if (family === 4) {
    return { version: 4, value: ipv4ToBigInt(addr) };
  }
  if (family === 6) {
    return { version: 6, value: ipv6ToBigInt(addr) };
  }
  return null;
}

export function parseNetwork(cidr: string): ParsedNetwork | null {
  const slash = cidr.indexOf('/');
  if (slash < 0) {
    const single = parseAddress(cidr);
    if (single === null) return null;
    const totalBits = single.version === 4 ? 32 : 128;
    return { version: single.version, network: single.value, prefix: totalBits, totalBits };
  }
  const host = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  if (prefixStr.length === 0 || !/^\d+$/.test(prefixStr)) return null;
  const prefix = Number.parseInt(prefixStr, 10);
  const parsed = parseAddress(host);
  if (parsed === null) return null;
  const totalBits = parsed.version === 4 ? 32 : 128;
  if (prefix < 0 || prefix > totalBits) return null;
  const hostBits = BigInt(totalBits - prefix);
  const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n;
  if ((parsed.value & hostMask) !== 0n) {
    return null;
  }
  return { version: parsed.version, network: parsed.value, prefix, totalBits };
}

export function addressInNetwork(addr: ParsedAddress, network: ParsedNetwork): boolean {
  if (addr.version !== network.version) return false;
  const hostBits = BigInt(network.totalBits - network.prefix);
  const mask = hostBits === 0n ? ~0n : ~((1n << hostBits) - 1n);
  return (addr.value & mask) === (network.network & mask);
}

export function subnetMatchEntries(snapshot: BridgeSnapshot, clientAddr: ParsedAddress): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [hostname, interfaces] of snapshot) {
    const ip = pickInterfaceIpForSubnet(interfaces, clientAddr);
    if (ip !== null) {
      out.push([ip, hostname]);
    }
  }
  return out;
}

function pickInterfaceIpForSubnet(interfaces: readonly unknown[], clientAddr: ParsedAddress): string | null {
  for (const entry of interfaces) {
    if (!isInterfaceDict(entry)) continue;
    if (typeof entry.iface !== 'string' || !isClientFacingName(entry.iface)) continue;
    const subnet = entry.subnet;
    const ip = entry.ip;
    if (typeof subnet !== 'string' || !subnet) continue;
    if (typeof ip !== 'string' || !isRoutableUnicastIpv4(ip)) continue;
    const network = parseNetwork(subnet);
    if (network === null) continue;
    if (addressInNetwork(clientAddr, network)) {
      return ip;
    }
  }
  return null;
}

function isInterfaceDict(value: unknown): value is InterfaceEntry {
  return isRecord(value);
}

function ipv4ToBigInt(addr: string): bigint {
  const parts = addr.split('.');
  let value = 0n;
  for (const part of parts) {
    value = (value << 8n) | BigInt(Number.parseInt(part, 10));
  }
  return value;
}

function ipv6ToBigInt(addr: string): bigint {
  const [main, embedded] = splitEmbeddedV4(addr);
  const targetGroupCount = embedded === null ? 8 : 6;
  const groups = expandIpv6Groups(main, targetGroupCount);
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  if (embedded !== null) {
    value = (value << 32n) | ipv4ToBigInt(embedded);
  }
  return value;
}

function splitEmbeddedV4(addr: string): [string, string | null] {
  const lastColon = addr.lastIndexOf(':');
  if (lastColon < 0) return [addr, null];
  const tail = addr.slice(lastColon + 1);
  if (isIP(tail) === 4) {
    return [addr.slice(0, lastColon), tail];
  }
  return [addr, null];
}

function expandIpv6Groups(main: string, targetGroupCount: number): string[] {
  if (main.length === 0) return Array<string>(targetGroupCount).fill('0');
  const doubleColonIdx = main.indexOf('::');
  if (doubleColonIdx < 0) {
    return main.split(':');
  }
  const head = main.slice(0, doubleColonIdx);
  const tail = main.slice(doubleColonIdx + 2);
  const headGroups = head.length === 0 ? [] : head.split(':');
  const tailGroups = tail.length === 0 ? [] : tail.split(':');
  const fill = targetGroupCount - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array<string>(fill).fill('0'), ...tailGroups];
}
