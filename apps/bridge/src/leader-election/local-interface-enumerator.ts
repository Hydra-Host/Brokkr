import { readFile } from 'node:fs/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

import { intToIpv4, ipv4ToInt } from '@repo/utils';

import type { InterfaceEntry, InterfaceEnumerator } from './leader-election.service';

type ListInterfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

const SKIP_PREFIXES = ['docker', 'br-', 'veth'];
const PROC_NET_ROUTE = '/proc/net/route';

function shouldSkip(name: string): boolean {
  if (name === 'lo') return true;
  return SKIP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function netmaskToPrefix(netmask: string): number | null {
  const parts = netmask.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  const inverted = ~value >>> 0;
  if (((inverted + 1) & inverted) !== 0) return null;
  let bits = 0;
  let v = value;
  while (v & 0x80000000) {
    bits += 1;
    v = (v << 1) >>> 0;
  }
  return bits;
}

export function ipv4Network(ip: string, prefix: number): string | null {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return null;
  if (prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  return `${intToIpv4(network)}/${prefix}`;
}

function hexToIpv4(value: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(value)) return null;
  const n = Number.parseInt(value, 16);
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}

function contactIp(addrs: Array<{ ip: string; prefix: number }>, gateway: string | null): string {
  if (gateway) {
    for (const a of addrs) {
      if (ipv4Network(gateway, a.prefix) === ipv4Network(a.ip, a.prefix)) return a.ip;
    }
  }
  return addrs[0].ip;
}

export function routedEntriesFromProc(
  routeTable: string,
  ifaceAddrs: Record<string, Array<{ ip: string; prefix: number }>>,
  ifaceMac: Record<string, string>,
): InterfaceEntry[] {
  return parseRouteTable(routeTable, ifaceAddrs, ifaceMac).routedEntries;
}

export function defaultGatewaysFromProc(routeTable: string): Map<string, string> {
  return parseRouteTable(routeTable, {}, {}).defaultGateways;
}

export function parseRouteTable(
  routeTable: string,
  ifaceAddrs: Record<string, Array<{ ip: string; prefix: number }>>,
  ifaceMac: Record<string, string>,
): { defaultGateways: Map<string, string>; routedEntries: InterfaceEntry[] } {
  const defaultGateways = new Map<string, string>();
  const routedEntries: InterfaceEntry[] = [];
  const seenSubnets = new Set<string>();

  for (const line of routeTable.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [iface, destHex, gatewayHex] = fields;

    if (destHex === '00000000' && gatewayHex !== '00000000') {
      const gw = hexToIpv4(gatewayHex);
      if (gw && !defaultGateways.has(iface)) defaultGateways.set(iface, gw);
      continue;
    }

    if (fields.length < 8) continue;
    if (gatewayHex === '00000000') continue;
    const maskHex = fields[7];
    const dest = hexToIpv4(destHex);
    const mask = maskHex ? hexToIpv4(maskHex) : null;
    if (dest === null || mask === null) continue;
    const prefix = netmaskToPrefix(mask);
    if (prefix === null || prefix <= 1) continue;
    const subnet = ipv4Network(dest, prefix);
    if (subnet === null) continue;
    const addrs = ifaceAddrs[iface];
    if (!addrs || addrs.length === 0) continue;
    if (seenSubnets.has(subnet)) continue;
    seenSubnets.add(subnet);
    const gateway = hexToIpv4(gatewayHex);
    routedEntries.push({
      iface,
      mac: ifaceMac[iface] ?? '',
      subnet,
      ip: contactIp(addrs, gateway),
      gateway: gateway ?? undefined,
      routed: true,
    });
  }

  // Matchers take the first containing entry, so the longest prefix must come first.
  routedEntries.sort((a, b) => parseInt(b.subnet.split('/')[1], 10) - parseInt(a.subnet.split('/')[1], 10));
  return { defaultGateways, routedEntries };
}

async function readRouteTable(): Promise<string> {
  try {
    return await readFile(PROC_NET_ROUTE, 'ascii');
  } catch {
    return '';
  }
}

export class OsNetworkInterfaceEnumerator implements InterfaceEnumerator {
  constructor(private readonly listInterfaces: ListInterfaces = networkInterfaces) {}

  async enumerate(): Promise<InterfaceEntry[]> {
    const ifaces = this.listInterfaces();
    const entries: InterfaceEntry[] = [];
    const ifaceAddrs: Record<string, Array<{ ip: string; prefix: number }>> = {};
    const ifaceMac: Record<string, string> = {};

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (shouldSkip(name)) continue;
      if (!addrs) continue;

      const mac = addrs[0]?.mac ?? '';
      if (mac) ifaceMac[name] = mac;

      for (const addr of addrs) {
        if (addr.family !== 'IPv4') continue;
        if (!addr.address || !addr.netmask) continue;
        const prefix = netmaskToPrefix(addr.netmask);
        if (prefix === null) continue;
        const subnet = ipv4Network(addr.address, prefix);
        if (subnet === null) continue;
        (ifaceAddrs[name] ??= []).push({ ip: addr.address, prefix });
        entries.push({
          iface: name,
          mac,
          subnet,
          ip: addr.address,
        });
      }
    }

    const routeTable = await readRouteTable();
    if (routeTable) {
      const { defaultGateways, routedEntries } = parseRouteTable(routeTable, ifaceAddrs, ifaceMac);

      for (const entry of entries) {
        const gw = defaultGateways.get(entry.iface);
        if (!gw) continue;
        const prefixLen = parseInt(entry.subnet.split('/')[1], 10);
        if (ipv4Network(gw, prefixLen) === entry.subnet) entry.gateway = gw;
      }
      entries.push(...routedEntries);
    }

    return entries;
  }
}
