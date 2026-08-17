import { Injectable } from '@nestjs/common';
import { parse as yamlLoad } from 'yaml';
import { getErrorMessage } from '../common/error-utils';

export class NetplanToKernelParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetplanToKernelParamsError';
  }
}

export const BOND_PARAM_MAPPING: Record<string, string> = {
  mode: 'mode',
  'lacp-rate': 'lacp_rate',
  'transmit-hash-policy': 'xmit_hash_policy',
  'mii-monitor-interval': 'miimon',
  'min-links': 'min_links',
  'ad-select': 'ad_select',
  'up-delay': 'updelay',
  'down-delay': 'downdelay',
  'gratuitous-arp': 'num_grat_arp',
  'primary-reselect': 'primary_reselect',
  'arp-validate': 'arp_validate',
  'arp-interval': 'arp_interval',
};

type NetworkConfig = Record<string, unknown>;

export interface ActiveBridgeIpsProvider {
  getActiveBridgeIps(jobId: string): Promise<string[]>;
}

export interface ConvertNetplanOptions {
  hostname?: string;
  bridgeIp?: string;
}

@Injectable()
export class NetplanToKernelParamsService {
  constructor(
    private readonly jobId: string = '',
    private readonly activeBridgeIpsProvider?: ActiveBridgeIpsProvider,
  ) {}

  async convertNetplanToKernelParams(netplanYaml: string, options: ConvertNetplanOptions = {}): Promise<string[]> {
    const { hostname = '', bridgeIp = '' } = options;
    try {
      const netplanConfig = requireDict(yamlLoad(netplanYaml));
      const network: NetworkConfig = 'network' in netplanConfig ? requireDict(netplanConfig.network) : {};

      const activeBridgeIps = this.activeBridgeIpsProvider
        ? await this.activeBridgeIpsProvider.getActiveBridgeIps(this.jobId)
        : [];

      return this.convertNetplanDictToKernelParams(network, hostname, bridgeIp, activeBridgeIps);
    } catch (error) {
      throw new NetplanToKernelParamsError(`Failed to convert Netplan to kernel params: ${getErrorMessage(error)}`);
    }
  }

  convertNetplanDictToKernelParams(
    networkConfig: NetworkConfig,
    hostname: string,
    bridgeIp: string,
    activeBridgeIps: string[],
  ): string[] {
    return [
      ...generateIfnameParams(networkConfig),
      ...generateBondParams(networkConfig),
      ...generateVlanParams(networkConfig),
      ...generateIpParams(networkConfig, hostname, bridgeIp, activeBridgeIps),
    ];
  }
}

function generateIfnameParams(networkConfig: NetworkConfig): string[] {
  const ifnameParams: string[] = [];
  const ethernets = requireMappingSlot(networkConfig.ethernets);

  for (const [ifaceName, ifaceConfigRaw] of Object.entries(ethernets)) {
    const ifaceConfig = requireMappingSlot(ifaceConfigRaw);
    const macAddress = extractMacAddress(ifaceName, ifaceConfig, ethernets);
    if (macAddress) {
      ifnameParams.push(`ifname=${ifaceName}:${macAddress}`);
    }
  }

  return ifnameParams;
}

function generateBondParams(networkConfig: NetworkConfig): string[] {
  const bondParams: string[] = [];
  const bonds = requireMappingSlot(networkConfig.bonds);

  for (const [bondName, bondConfigRaw] of Object.entries(bonds)) {
    const bondConfig = requireMappingSlot(bondConfigRaw);
    const interfaces = bondConfig.interfaces;
    if (!interfaces || !Array.isArray(interfaces) || interfaces.length === 0) continue;

    const slaves = (interfaces as string[]).join(',');
    let bondParam = `bond=${bondName}:${slaves}`;

    const parameters = bondConfig.parameters;
    if (
      parameters &&
      typeof parameters === 'object' &&
      !Array.isArray(parameters) &&
      Object.keys(parameters).length > 0
    ) {
      const params = parameters as Record<string, unknown>;
      const options: string[] = [];
      for (const [netplanParam, bondOption] of Object.entries(BOND_PARAM_MAPPING)) {
        if (netplanParam in params) {
          options.push(`${bondOption}=${String(params[netplanParam])}`);
        }
      }
      if (options.length > 0) {
        bondParam += ':' + options.join(',');
      }
    }

    bondParams.push(bondParam);
  }

  return bondParams;
}

function generateVlanParams(networkConfig: NetworkConfig): string[] {
  const vlanParams: string[] = [];
  const vlans = requireMappingSlot(networkConfig.vlans);

  for (const [vlanName, vlanConfigRaw] of Object.entries(vlans)) {
    const vlanConfig = requireMappingSlot(vlanConfigRaw);
    const link = vlanConfig.link;
    if (!link) continue;
    vlanParams.push(`vlan=${vlanName}:${String(link)}`);
  }

  return vlanParams;
}

function generateIpParams(
  networkConfig: NetworkConfig,
  hostname: string,
  bridgeIp: string,
  activeBridgeIpsRaw: string[],
): string[] {
  const ipParams: string[] = [];
  const ipParamsWithGateway: string[] = [];
  const interfacesWithIps: Array<[string, NetworkConfig]> = [];

  const ethernets = requireMappingSlot(networkConfig.ethernets);
  const bonds = requireMappingSlot(networkConfig.bonds);
  const vlans = requireMappingSlot(networkConfig.vlans);

  for (const [ifaceName, ifaceConfigRaw] of Object.entries(ethernets)) {
    const ifaceConfig = requireMappingSlot(ifaceConfigRaw);
    if (ifaceConfig.addresses && Array.isArray(ifaceConfig.addresses) && ifaceConfig.addresses.length > 0) {
      interfacesWithIps.push([ifaceName, ifaceConfig]);
    }
  }

  for (const [bondName, bondConfigRaw] of Object.entries(bonds)) {
    const bondConfig = requireMappingSlot(bondConfigRaw);
    if (bondConfig.addresses && Array.isArray(bondConfig.addresses) && bondConfig.addresses.length > 0) {
      interfacesWithIps.push([bondName, bondConfig]);
    }
  }

  for (const [vlanName, vlanConfigRaw] of Object.entries(vlans)) {
    const vlanConfig = requireMappingSlot(vlanConfigRaw);
    if (vlanConfig.addresses && Array.isArray(vlanConfig.addresses) && vlanConfig.addresses.length > 0) {
      interfacesWithIps.push([vlanName, vlanConfig]);
    }
  }

  if (interfacesWithIps.length === 0) {
    return [];
  }

  const activeBridgeNetworks = activeBridgeIpsRaw.map((ip) => ipv4Network(ip));

  for (const [logicalName, ifaceConfig] of interfacesWithIps) {
    const addresses = ifaceConfig.addresses;
    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) continue;

    const address = addresses[0] as string;
    const [ipAddr] = splitSlashPair(address);

    const network = ipv4Network(address, false);
    const netmask = network.netmask;

    const gateway = extractGateway(ifaceConfig);

    const dns1 = bridgeIp ? bridgeIp : '1.1.1.1';
    const dns2 = bridgeIp ? '' : '8.8.8.8';
    const ipParam = `ip=${ipAddr}::${gateway}:${netmask}:${hostname}:${logicalName}:none:${dns1}:${dns2}`;

    if (gateway === '') {
      ipParams.push(ipParam);
    } else if (activeBridgeNetworks.some((bridgeNet) => networksOverlap(network, bridgeNet))) {
      ipParamsWithGateway.push(ipParam);
    } else {
      ipParams.push(ipParam);
    }
  }

  return [...ipParams, ...ipParamsWithGateway];
}

function extractGateway(ifaceConfig: NetworkConfig): string {
  const routes = 'routes' in ifaceConfig && Array.isArray(ifaceConfig.routes) ? ifaceConfig.routes : [];
  for (const routeRaw of routes) {
    const route = requireMappingSlot(routeRaw);
    if (route.to === '0.0.0.0/0' || route.to === 'default') {
      return 'via' in route ? String(route.via) : '';
    }
  }
  return 'gateway4' in ifaceConfig ? String(ifaceConfig.gateway4) : '';
}

function extractMacAddress(logicalName: string, ifaceConfig: NetworkConfig, ethernets: NetworkConfig): string {
  const matchConfig = requireMappingSlot(ifaceConfig.match);
  if (matchConfig.macaddress) {
    return String(matchConfig.macaddress);
  }

  if (logicalName in ethernets) {
    const ethernetConfig = requireMappingSlot(ethernets[logicalName]);
    const ethernetMatch = requireMappingSlot(ethernetConfig.match);
    if (ethernetMatch.macaddress) {
      return String(ethernetMatch.macaddress);
    }
  }

  if ('macaddress' in ifaceConfig) {
    return ifaceConfig.macaddress ? String(ifaceConfig.macaddress) : '';
  }

  return '';
}

interface Ipv4NetworkInfo {
  networkInt: number;
  prefix: number;
  netmask: string;
}

function ipv4Network(value: string, strict = true): Ipv4NetworkInfo {
  const slash = value.indexOf('/');
  const addrPart = slash === -1 ? value : value.slice(0, slash);
  const prefixPart = slash === -1 ? '32' : value.slice(slash + 1);

  const addrInt = parseIpv4(addrPart);
  const prefix = parsePrefix(prefixPart);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (addrInt & mask) >>> 0;

  if (strict && networkInt !== addrInt) {
    throw new Error(`${value} has host bits set`);
  }

  return { networkInt, prefix, netmask: intToIpv4(mask) };
}

function networksOverlap(a: Ipv4NetworkInfo, b: Ipv4NetworkInfo): boolean {
  const prefix = Math.min(a.prefix, b.prefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (a.networkInt & mask) >>> 0 === (b.networkInt & mask) >>> 0;
}

function parseIpv4(addr: string): number {
  const parts = addr.split('.');
  if (parts.length !== 4) throw new Error(`${addr} does not appear to be an IPv4 address`);
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`${addr} does not appear to be an IPv4 address`);
    if (part.length > 1 && part[0] === '0') throw new Error(`${addr} does not appear to be an IPv4 address`);
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) throw new Error(`${addr} does not appear to be an IPv4 address`);
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

function parsePrefix(prefixPart: string): number {
  if (!/^\d+$/.test(prefixPart)) throw new Error(`${prefixPart} is not a valid prefix length`);
  const prefix = Number.parseInt(prefixPart, 10);
  if (prefix < 0 || prefix > 32) throw new Error(`${prefixPart} is not a valid prefix length`);
  return prefix;
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

function splitSlashPair(value: string): [string, string] {
  const parts = value.split('/');
  if (parts.length !== 2) {
    throw new Error(`expected one '/' in address, got ${parts.length - 1}`);
  }
  return [parts[0], parts[1]];
}

function requireDict(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`expected object, got ${typeof value}`);
}

function requireMappingSlot(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`expected object, got ${typeof value}`);
}
