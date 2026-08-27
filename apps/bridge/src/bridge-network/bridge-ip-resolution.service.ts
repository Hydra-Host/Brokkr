import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import { getErrorMessage } from '../common/error-utils';

import { URL } from 'node:url';

import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';

import { getLogger } from '../logger/logger.service';
import { ipv4ToInt, isRoutableUnicastIpv4, isValidIpv4Cidr } from './ip-utils';

const DEFAULT_BRIDGE_URL = 'https://brokkr.lan';
const INTERFACES_CACHE_KEY = 'bridge:interfaces';

export class BridgeIpResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeIpResolutionError';
  }
}

export interface NetworkInterface {
  name: string;
  ip: string;
  netmask: string;
  prefix: number;
  network: string;
  isPrimary: boolean;
  interfaceType: string;
}

export interface ResolutionCache {
  get(key: string, jobId?: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
}

export interface AppConfigProvider {
  readonly bridgeUrl: string | null;
}

export interface NetplanAddressExtractor {
  extract(netplanYaml: string): string[];
}

export interface BridgeIpResolutionDeps {
  jobId?: string;
  cache?: ResolutionCache | null;
  appConfig?: AppConfigProvider;
  netplanAddressExtractor: NetplanAddressExtractor;
  interfaceDiscovery?: () => NetworkInterface[];
  egressSourceIpFn?: (targetIp: string) => Promise<string | null>;
  requestClientIpProvider?: (() => string | null) | null;
  hostnameResolver?: ((hostname: string) => Promise<string> | string) | null;
  interfaceCacheTtlSeconds?: number | null;
}

export function classifyInterfaceType(name: string): string {
  if (name.startsWith('eth') || name.startsWith('ens') || name.startsWith('enp')) return 'physical';
  if (name.startsWith('docker') || name.startsWith('br-')) return 'container';
  return 'other';
}

export function discoverIpv4Interfaces(
  enumerate: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): NetworkInterface[] {
  const interfaces: NetworkInterface[] = [];
  for (const [name, entries] of Object.entries(enumerate())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') continue;
      const ip = entry.address;
      const prefix = prefixFromNetmask(entry.netmask);
      if (prefix === null || !isRoutableUnicastIpv4(ip)) continue;
      interfaces.push({
        name,
        ip,
        netmask: entry.netmask,
        prefix,
        network: ipv4NetworkCidr(ip, prefix),
        isPrimary: interfaces.length === 0,
        interfaceType: classifyInterfaceType(name),
      });
    }
  }
  return interfaces;
}

const NON_CLIENT_FACING_PREFIXES = ['lo', 'docker', 'br-', 'veth', 'cni', 'flannel', 'tun', 'wt', 'ipmi'];

export interface SelfInterfaceOptions {
  clientFacingOnly?: boolean;
}

export interface SelfPrimaryInterface {
  ip: string;
  netmask: string;
  prefix: number;
  network: string;
  broadcast: string;
}

export interface PoolRange {
  rangeStart: string;
  rangeEnd: string;
}

export function isClientFacingName(name: string): boolean {
  return !NON_CLIENT_FACING_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix));
}

export function selfInterfaces(
  opts: SelfInterfaceOptions = {},
  discover: () => NetworkInterface[] = discoverIpv4Interfaces,
): NetworkInterface[] {
  const all = discover();
  if (!opts.clientFacingOnly) return all;
  const filtered = all.filter((iface) => isClientFacingName(iface.name));
  return filtered.map((iface, index) => ({ ...iface, isPrimary: index === 0 }));
}

export function resolveServiceInterfaces(
  discover: () => NetworkInterface[] = discoverIpv4Interfaces,
): NetworkInterface[] {
  return selfInterfaces({ clientFacingOnly: true }, discover);
}

export function selfPrimary(
  opts: SelfInterfaceOptions = {},
  discover: () => NetworkInterface[] = discoverIpv4Interfaces,
): SelfPrimaryInterface | null {
  const interfaces = selfInterfaces(opts, discover);
  const primary = interfaces.find((iface) => iface.isPrimary) ?? interfaces[0];
  if (!primary) return null;
  const broadcast = ipv4Broadcast(primary.ip, primary.prefix);
  if (broadcast === null) return null;
  return {
    ip: primary.ip,
    netmask: primary.netmask,
    prefix: primary.prefix,
    network: primary.network,
    broadcast,
  };
}

export function deriveDefaultPool(primary: SelfPrimaryInterface): PoolRange | null {
  if (primary.prefix !== 24) return null;
  const ipInt = ipv4ToInt(primary.ip);
  if (ipInt === null) return null;
  const mask = (0xffffffff << (32 - 24)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return {
    rangeStart: intToIpv4((network + 1) >>> 0),
    rangeEnd: intToIpv4((broadcast - 1) >>> 0),
  };
}

function ipv4Broadcast(addr: string, prefix: number): string | null {
  const ipInt = ipv4ToInt(addr);
  if (ipInt === null) return null;
  if (prefix === 0) return '255.255.255.255';
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return intToIpv4(broadcast);
}

export function egressSourceIp(targetIp: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let done = false;
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (error) {
        void getLogger().debug(`Egress probe socket close failed: ${getErrorMessage(error)}`);
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 1000);
    socket.on('error', () => finish(null));
    try {
      socket.connect(1, targetIp, () => {
        try {
          finish(socket.address().address);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

@Injectable()
export class BridgeIpResolutionService {
  readonly jobId: string;
  private cache: ResolutionCache | null;
  private readonly appConfig: AppConfigProvider;
  private readonly netplanAddressExtractor: NetplanAddressExtractor;
  private readonly interfaceDiscovery: () => NetworkInterface[];
  private readonly egressSourceIpFn: (targetIp: string) => Promise<string | null>;
  private readonly requestClientIpProvider: (() => string | null) | null;
  private readonly hostnameResolver: ((hostname: string) => Promise<string> | string) | null;
  private readonly interfaceCacheTtlSeconds: number | null;

  constructor(deps: BridgeIpResolutionDeps) {
    this.jobId = deps.jobId ?? '';
    this.cache = deps.cache ?? null;
    this.appConfig = deps.appConfig ?? { bridgeUrl: null };
    this.netplanAddressExtractor = deps.netplanAddressExtractor;
    this.interfaceDiscovery = deps.interfaceDiscovery ?? discoverIpv4Interfaces;
    this.egressSourceIpFn = deps.egressSourceIpFn ?? egressSourceIp;
    this.requestClientIpProvider = deps.requestClientIpProvider ?? null;
    this.hostnameResolver = deps.hostnameResolver ?? null;
    this.interfaceCacheTtlSeconds = deps.interfaceCacheTtlSeconds ?? null;
  }

  async getBridgeUrlForRequest(): Promise<string> {
    let clientIp: string | null = null;
    try {
      const configured = this.appConfig.bridgeUrl;
      if (configured && configured !== DEFAULT_BRIDGE_URL) {
        void getLogger().debug(`BRIDGE_URL override: ${configured} (bypassing interface logic) job=${this.jobId}`);
        return configured;
      }

      clientIp = this.getRequestContextClientIp();
      if (!clientIp) {
        void getLogger().warning(`No HTTP request context available, using primary bridge URL job=${this.jobId}`);
        return await this.getPrimaryBridgeUrl();
      }

      void getLogger().debug(
        `Auto-detected client IP from request context: ${clientIp}, resolving interface job=${this.jobId}`,
      );

      const interfaceIp = await this.checkDirectNetworkMembership(clientIp);
      if (interfaceIp) {
        const bridgeUrl = `https://${interfaceIp}`;
        void getLogger().debug(`Same-network client: ${clientIp} → ${bridgeUrl} job=${this.jobId}`);
        return bridgeUrl;
      }

      const routeIp = await this.getRouteInterfaceForClient(clientIp);
      if (routeIp) {
        const bridgeUrl = `https://${routeIp}`;
        void getLogger().info(`Layer 3 routed client: ${clientIp} → ${bridgeUrl} job=${this.jobId}`);
        return bridgeUrl;
      }

      const primaryIp = await this.getPrimaryInterfaceIp();
      if (primaryIp) {
        const bridgeUrl = `https://${primaryIp}`;
        void getLogger().warning(`Fallback for unknown client: ${clientIp} → ${bridgeUrl} job=${this.jobId}`);
        return bridgeUrl;
      }

      throw new BridgeIpResolutionError(`Could not determine bridge interface for client IP: ${clientIp}`);
    } catch (error) {
      if (error instanceof BridgeIpResolutionError) throw error;
      const msg = getErrorMessage(error);
      void getLogger().error(`Unexpected error resolving bridge URL for client ${clientIp}: ${msg} job=${this.jobId}`);
      throw new BridgeIpResolutionError(`Bridge URL resolution failed: ${msg}`);
    }
  }

  async getBridgeIpForDevice(netplanYaml: string): Promise<string> {
    try {
      const deviceAddresses = this.netplanAddressExtractor.extract(netplanYaml);
      if (deviceAddresses.length === 0) {
        return await this.getBridgeIpForHostsFile();
      }

      const interfaces = await this.getBridgeInterfaces();
      for (const deviceAddr of deviceAddresses) {
        for (const iface of interfaces) {
          if (ipInCidr(iface.network, deviceAddr)) {
            void getLogger().debug(
              `Device address ${deviceAddr} overlaps bridge interface ${iface.name} (${iface.ip}/${networkPrefix(iface.network)}); using ${iface.ip} for hosts file job=${this.jobId}`,
            );
            return iface.ip;
          }
        }
      }

      void getLogger().debug(
        `No bridge interface overlaps device netplan addresses; falling back to primary resolution job=${this.jobId}`,
      );
      return await this.getBridgeIpForHostsFile();
    } catch (error) {
      void getLogger().warning(
        `Device-aware bridge IP resolution failed, falling back: ${getErrorMessage(error)} job=${this.jobId}`,
      );
      return this.getBridgeIpForHostsFile();
    }
  }

  async getBridgeIpForHostsFile(): Promise<string> {
    try {
      const bridgeUrl = await this.getBridgeUrlForRequest();
      const bridgeIp = await this.resolveBridgeUrlToIp(bridgeUrl);
      void getLogger().debug(`Bridge IP for hosts file: ${bridgeIp} job=${this.jobId}`);
      return bridgeIp;
    } catch (error) {
      void getLogger().error(`Failed to get bridge IP for hosts file: ${getErrorMessage(error)} job=${this.jobId}`);
      return '127.0.0.1';
    }
  }

  async getPrimaryBridgeUrl(): Promise<string> {
    try {
      const configured = this.appConfig.bridgeUrl;
      if (configured && configured !== DEFAULT_BRIDGE_URL) return configured;

      const primaryIp = await this.getPrimaryInterfaceIp();
      if (!primaryIp) {
        throw new BridgeIpResolutionError('Could not determine primary bridge interface');
      }
      return `https://${primaryIp}`;
    } catch (error) {
      if (error instanceof BridgeIpResolutionError) throw error;
      const msg = getErrorMessage(error);
      void getLogger().error(`Failed to get primary bridge URL: ${msg} job=${this.jobId}`);
      throw new BridgeIpResolutionError(`Primary bridge URL resolution failed: ${msg}`);
    }
  }

  async checkDirectNetworkMembership(clientIp: string): Promise<string | null> {
    try {
      if (isIP(clientIp) === 0) {
        throw new Error(`'${clientIp}' does not appear to be an IPv4 or IPv6 address`);
      }
      const interfaces = await this.getBridgeInterfaces();
      void getLogger().debug(
        `Checking direct network membership for ${clientIp} against ${interfaces.length} interfaces job=${this.jobId}`,
      );
      for (const iface of interfaces) {
        if (ipInCidr(iface.network, clientIp)) {
          void getLogger().debug(
            `Direct match: ${clientIp} ∈ ${iface.network} → interface ${iface.name} (${iface.ip}) job=${this.jobId}`,
          );
          return iface.ip;
        }
      }
      void getLogger().debug(`No direct network membership found for ${clientIp} job=${this.jobId}`);
      return null;
    } catch (error) {
      void getLogger().warning(
        `Direct network membership check failed for ${clientIp}: ${getErrorMessage(error)} job=${this.jobId}`,
      );
      return null;
    }
  }

  async getRouteInterfaceForClient(clientIp: string): Promise<string | null> {
    try {
      void getLogger().debug(`Performing route analysis for client ${clientIp} job=${this.jobId}`);
      const srcIp = await this.egressSourceIpFn(clientIp);
      if (!srcIp) {
        void getLogger().debug(`Egress source IP probe returned no result for ${clientIp} job=${this.jobId}`);
        return null;
      }
      const interfaces = await this.getBridgeInterfaces();
      const matching = interfaces.find((iface) => iface.ip === srcIp);
      if (matching) {
        void getLogger().debug(
          `Route analysis success: ${clientIp} → dev ${matching.name} src ${srcIp} job=${this.jobId}`,
        );
        return srcIp;
      }
      void getLogger().warning(`Route analysis found unknown interface IP ${srcIp} for ${clientIp} job=${this.jobId}`);
      return null;
    } catch (error) {
      void getLogger().warning(`Route analysis failed for ${clientIp}: ${getErrorMessage(error)} job=${this.jobId}`);
      return null;
    }
  }

  private async getBridgeInterfaces(): Promise<NetworkInterface[]> {
    try {
      void getLogger().debug(`Discovering bridge network interfaces job=${this.jobId}`);

      const cache = this.cache;
      if (cache) {
        try {
          const cached = await cache.get(INTERFACES_CACHE_KEY, this.jobId);
          if (cached) {
            const interfaces = deserializeInterfaces(cached);
            void getLogger().debug(`Using cached interface data (${interfaces.length} interfaces) job=${this.jobId}`);
            return interfaces;
          }
        } catch (error) {
          void getLogger().debug(
            `Cache read failed for bridge interfaces: ${getErrorMessage(error)} job=${this.jobId}`,
          );
        }
      }

      const interfaces = this.interfaceDiscovery();
      for (const iface of interfaces) {
        void getLogger().debug(
          `Found interface: ${iface.name} (${iface.interfaceType}) - ${iface.ip}/${networkPrefix(iface.network)} job=${this.jobId}`,
        );
      }

      if (interfaces.length === 0) {
        throw new BridgeIpResolutionError('No valid network interfaces found');
      }

      if (cache) {
        try {
          await cache.set(
            INTERFACES_CACHE_KEY,
            serializeInterfaces(interfaces),
            this.interfaceCacheTtlSeconds ?? undefined,
            this.jobId,
          );
        } catch (error) {
          void getLogger().debug(`Failed to cache bridge interfaces: ${getErrorMessage(error)} job=${this.jobId}`);
        }
      }

      void getLogger().info(`Discovered ${interfaces.length} bridge interfaces job=${this.jobId}`);
      return interfaces;
    } catch (error) {
      if (error instanceof BridgeIpResolutionError) throw error;
      const msg = getErrorMessage(error);
      void getLogger().error(`Failed to discover bridge interfaces: ${msg} job=${this.jobId}`);
      throw new BridgeIpResolutionError(`Interface discovery failed: ${msg}`);
    }
  }

  private async getPrimaryInterfaceIp(): Promise<string | null> {
    try {
      const interfaces = await this.getBridgeInterfaces();
      const primary = interfaces.find((iface) => iface.isPrimary);
      if (primary) {
        void getLogger().debug(`Using primary interface: ${primary.name} (${primary.ip}) job=${this.jobId}`);
        return primary.ip;
      }
      const first = interfaces[0];
      if (first) {
        void getLogger().debug(`Using first available interface: ${first.name} (${first.ip}) job=${this.jobId}`);
        return first.ip;
      }
      return null;
    } catch (error) {
      void getLogger().error(`Failed to get primary interface IP: ${getErrorMessage(error)} job=${this.jobId}`);
      return null;
    }
  }

  private async resolveBridgeUrlToIp(bridgeUrl: string): Promise<string> {
    try {
      const hostname = parseUrlHostname(bridgeUrl);
      if (!hostname) {
        void getLogger().warning(`Could not parse hostname from bridge URL: ${bridgeUrl} job=${this.jobId}`);
        return bridgeUrl;
      }
      if (isIP(hostname) !== 0) {
        void getLogger().debug(`Bridge URL hostname is already an IP: ${hostname} job=${this.jobId}`);
        return hostname;
      }
      void getLogger().debug(`Resolving FQDN to IP: ${hostname} job=${this.jobId}`);
      const resolved =
        this.hostnameResolver !== null
          ? await this.hostnameResolver(hostname)
          : (await lookup(hostname, { family: 4 })).address;
      void getLogger().info(`Resolved ${hostname} → ${resolved} job=${this.jobId}`);
      return resolved;
    } catch (error) {
      void getLogger().warning(
        `Failed to resolve bridge URL ${bridgeUrl} to IP: ${getErrorMessage(error)} job=${this.jobId}`,
      );
      return parseUrlHostname(bridgeUrl) ?? bridgeUrl;
    }
  }

  private getRequestContextClientIp(): string | null {
    if (this.requestClientIpProvider === null) return null;
    try {
      return this.requestClientIpProvider();
    } catch {
      return null;
    }
  }
}

export function createBridgeIpResolutionService(deps: BridgeIpResolutionDeps): BridgeIpResolutionService {
  return new BridgeIpResolutionService(deps);
}

function networkPrefix(network: string): string {
  const slash = network.indexOf('/');
  return slash === -1 ? '' : network.slice(slash + 1);
}

function parseUrlHostname(value: string): string | null {
  try {
    const hostname = new URL(value).hostname;
    if (!hostname) return null;
    if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
    return hostname;
  } catch {
    return null;
  }
}

function ipv4NetworkCidr(addr: string, prefix: number): string {
  const ipInt = ipv4ToInt(addr);
  if (ipInt === null) return `${addr}/${prefix}`;
  if (prefix === 0) return `0.0.0.0/0`;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  return `${intToIpv4(network)}/${prefix}`;
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

function prefixFromNetmask(netmask: string): number | null {
  if (!isIPv4(netmask)) return null;
  const value = ipv4ToInt(netmask);
  if (value === null) return null;
  if (value === 0) return 0;
  const inverted = (~value >>> 0) + 1;
  if ((inverted & (inverted - 1)) !== 0) return null;
  let prefix = 0;
  let probe = value;
  while (probe !== 0) {
    prefix += probe & 1;
    probe >>>= 1;
  }
  return prefix;
}

export function ipInCidr(cidr: string, addr: string): boolean {
  if (!isValidIpv4Cidr(cidr) || !isIPv4(addr)) return false;
  const slash = cidr.indexOf('/');
  const prefix = Number.parseInt(cidr.slice(slash + 1), 10);
  const netInt = ipv4ToInt(cidr.slice(0, slash));
  const addrInt = ipv4ToInt(addr);
  if (netInt === null || addrInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (netInt & mask) === (addrInt & mask);
}

export function serializeInterfaces(interfaces: NetworkInterface[]): string {
  const items = interfaces.map(
    (i) =>
      `{"name": ${JSON.stringify(i.name)}, "ip": ${JSON.stringify(i.ip)}, "netmask": ${JSON.stringify(i.netmask)}, "prefix": ${i.prefix}, "network": ${JSON.stringify(i.network)}, "is_primary": ${i.isPrimary}, "interface_type": ${JSON.stringify(i.interfaceType)}}`,
  );
  return `[${items.join(', ')}]`;
}

export function deserializeInterfaces(data: string): NetworkInterface[] {
  const parsed: unknown = JSON.parse(data);
  if (!Array.isArray(parsed)) throw new Error('interface cache payload is not a list');
  return parsed.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('interface cache entry is not an object');
    }
    const name = entry.name;
    const ip = entry.ip;
    const netmask = entry.netmask;
    const prefix = entry.prefix;
    const network = entry.network;
    const isPrimary = entry.is_primary;
    const interfaceType = entry.interface_type;
    if (
      typeof name !== 'string' ||
      typeof ip !== 'string' ||
      typeof netmask !== 'string' ||
      typeof prefix !== 'number' ||
      typeof network !== 'string' ||
      typeof isPrimary !== 'boolean' ||
      typeof interfaceType !== 'string'
    ) {
      throw new Error('interface cache entry has invalid fields');
    }
    return { name, ip, netmask, prefix, network, isPrimary, interfaceType };
  });
}
