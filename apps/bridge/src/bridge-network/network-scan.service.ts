import { Injectable, Logger } from '@nestjs/common';
import { request } from 'node:https';
import { Socket, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { getErrorMessage } from '../common/error-utils';

import { isRecord } from '@repo/utils';

import { CommandFailed, CommandTimeout, run } from '../common/process/run-command';
import { ipmiPing } from '../oob/ipmi/ping';
import {
  isTlsCertVerificationError,
  redfishRejectUnauthorized,
  redfishTlsVerificationFailureHint,
  warnRedfishTlsVerificationDisabledOnce,
} from '../redfish/redfish.config.js';
import { getNetworkConfig, type NetworkConfig } from './network.config';

const APP_CLASS_NAME = 'service-network-scan';

const probeLogger = new Logger(APP_CLASS_NAME);
let warnedTlsVerificationFailure = false;
function warnRedfishTlsVerificationFailureOnce(host: string): void {
  if (warnedTlsVerificationFailure) return;
  warnedTlsVerificationFailure = true;
  probeLogger.warn(redfishTlsVerificationFailureHint(host));
}

const ARP_AN_LINE_RE = /\(([0-9.]+)\)\s+at\s+([0-9a-fA-F:]+)\s+on\s+\S+/;
const NMAP_HOST_LINE_RE = /^Host:\s+(\S+)\s+(?:\([^)]*\)\s+)?Status:\s+Up\b/;

export class NetworkScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkScanError';
  }
}

export class NetworkScanValidationError extends NetworkScanError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkScanValidationError';
  }
}

export class NetworkScanTimeoutError extends NetworkScanError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkScanTimeoutError';
  }
}

export interface HostResult {
  mac: string;
  ipmi: boolean;
  redfish: boolean;
}

export interface SubnetScanResultInternal {
  errored: boolean;
  results: Map<string, HostResult>;
  errorMessage: string | null;
}

export interface SubnetScanOutput {
  errored: boolean;
  results: Record<string, HostResult>;
}

export interface RunResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Runner = (cmd: readonly string[], timeoutSeconds?: number) => Promise<RunResultLike>;

export interface NetworkScanDeps {
  runner?: Runner;
  ipmiPingFn?: (ip: string) => Promise<boolean>;
  redfishCheckFn?: (ip: string) => Promise<boolean>;
  localIpsProvider?: (network: string) => Set<string>;
  gatewayIpProvider?: (network: string) => Promise<string | null>;
  nmapDiscover?: (network: string) => Promise<string[]>;
  config?: NetworkConfig;
}

export function normalizeMac(mac: string): string {
  const lower = mac.toLowerCase();
  const parts = lower.split(':');
  if (parts.length !== 6) return lower;
  const formatted: string[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]+$/.test(part)) return lower;
    formatted.push(parseInt(part, 16).toString(16).padStart(2, '0'));
  }
  return formatted.join(':');
}

export function parseNmapGreppableOutput(stdout: string): string[] {
  const hosts: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = NMAP_HOST_LINE_RE.exec(line.trim());
    const ip = match?.[1];
    if (ip !== undefined && !hosts.includes(ip)) hosts.push(ip);
  }
  return hosts;
}

export function parseIpNeighbourJson(
  stdout: string,
  hostsSet: ReadonlySet<string>,
  logger?: Logger,
  jobId = '',
): Record<string, string> {
  const macMap: Record<string, string> = {};
  const parsed: unknown = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed)) return macMap;

  for (const neighbour of parsed) {
    if (!isRecord(neighbour)) continue;
    const ip = typeof neighbour['dst'] === 'string' ? neighbour['dst'] : '';
    const mac = typeof neighbour['lladdr'] === 'string' ? neighbour['lladdr'] : '';
    if (!hostsSet.has(ip) || !mac) continue;
    const normalized = normalizeMac(mac);
    const existing = macMap[ip];
    if (existing !== undefined && existing !== normalized) {
      logger?.warn(
        `IP ${ip} seen with multiple MACs, keeping first: ${existing} (ignoring ${normalized}) [${APP_CLASS_NAME}] job=${jobId}`,
      );
      continue;
    }
    macMap[ip] = normalized;
  }

  return macMap;
}

export function parseArpAnOutput(
  stdout: string,
  hostsSet: ReadonlySet<string>,
  logger?: Logger,
  jobId = '',
): Record<string, string> {
  const macMap: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const match = ARP_AN_LINE_RE.exec(line);
    if (!match) continue;
    const ip = match[1];
    const mac = match[2];
    if (ip === undefined || mac === undefined) continue;
    if (!hostsSet.has(ip) || mac.toLowerCase() === 'incomplete') continue;
    const normalized = normalizeMac(mac);
    const existing = macMap[ip];
    if (existing !== undefined && existing !== normalized) {
      logger?.warn(
        `IP ${ip} seen with multiple MACs, keeping first: ${existing} (ignoring ${normalized}) [${APP_CLASS_NAME}] job=${jobId}`,
      );
      continue;
    }
    macMap[ip] = normalized;
  }
  return macMap;
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

interface ParsedV4Network {
  family: 4;
  networkInt: number;
  prefix: number;
}

interface ParsedV6Network {
  family: 6;
  bits: string;
  prefix: number;
}

type ParsedNetwork = ParsedV4Network | ParsedV6Network;

function expandIpv6(addr: string): string | null {
  if (addr.includes('.')) return null;
  const hasDouble = addr.includes('::');
  const partsRaw = addr.split('::');
  if (partsRaw.length > 2) return null;
  if (!hasDouble) {
    const groups = addr.split(':');
    if (groups.length !== 8) return null;
    return groups.map((g) => g.padStart(4, '0')).join(':');
  }
  const left = partsRaw[0] === '' ? [] : (partsRaw[0] ?? '').split(':');
  const right = partsRaw[1] === '' ? [] : (partsRaw[1] ?? '').split(':');
  const fillCount = 8 - left.length - right.length;
  if (fillCount < 0) return null;
  const filled = new Array<string>(fillCount).fill('0000');
  const groups = [...left, ...filled, ...right];
  if (groups.length !== 8) return null;
  return groups.map((g) => (g === '' ? '0000' : g.padStart(4, '0'))).join(':');
}

function ipv6ToBits(addr: string): string | null {
  const expanded = expandIpv6(addr);
  if (expanded === null) return null;
  let bits = '';
  for (const group of expanded.split(':')) {
    const num = Number.parseInt(group, 16);
    if (!Number.isInteger(num) || num < 0 || num > 0xffff) return null;
    bits += num.toString(2).padStart(16, '0');
  }
  return bits;
}

export function tryParseCidr(value: string): ParsedNetwork | null {
  const slash = value.indexOf('/');
  const host = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(host);
  if (family === 0) return null;

  if (family === 4) {
    let prefix: number;
    if (slash === -1) {
      prefix = 32;
    } else {
      const prefixStr = value.slice(slash + 1);
      if (!/^\d+$/.test(prefixStr)) return null;
      prefix = Number.parseInt(prefixStr, 10);
      if (prefix < 0 || prefix > 32) return null;
    }
    const hostInt = ipv4ToInt(host);
    if (hostInt === null) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const networkInt = (hostInt & mask) >>> 0;
    return { family: 4, networkInt, prefix };
  }

  let prefix: number;
  if (slash === -1) {
    prefix = 128;
  } else {
    const prefixStr = value.slice(slash + 1);
    if (!/^\d+$/.test(prefixStr)) return null;
    prefix = Number.parseInt(prefixStr, 10);
    if (prefix < 0 || prefix > 128) return null;
  }
  const bits = ipv6ToBits(host);
  if (bits === null) return null;
  const networkBits = bits.slice(0, prefix).padEnd(128, '0');
  return { family: 6, bits: networkBits, prefix };
}

export function cidrContains(network: ParsedNetwork, addr: string): boolean {
  const family = isIP(addr);
  if (family === 0 || family !== network.family) return false;
  if (network.family === 4) {
    const addrInt = ipv4ToInt(addr);
    if (addrInt === null) return false;
    if (network.prefix === 0) return true;
    const mask = (0xffffffff << (32 - network.prefix)) >>> 0;
    return (addrInt & mask) >>> 0 === network.networkInt;
  }
  const addrBits = ipv6ToBits(addr);
  if (addrBits === null) return false;
  return addrBits.slice(0, network.prefix) === network.bits.slice(0, network.prefix);
}

function tcpConnect(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip, () => finish(true));
  });
}

function httpsRedfishProbe(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rejectUnauthorized = redfishRejectUnauthorized();
    if (!rejectUnauthorized) warnRedfishTlsVerificationDisabledOnce((m) => probeLogger.warn(m), `${ip}:${port}`);
    const req = request(
      {
        host: ip,
        port,
        path: '/redfish/v1',
        method: 'GET',
        rejectUnauthorized,
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(isRecord(body) && 'RedfishVersion' in body);
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      },
    );
    req.on('timeout', () => req.destroy(new Error('redfish request timed out')));
    req.on('error', (err) => {
      if (rejectUnauthorized && isTlsCertVerificationError(err)) warnRedfishTlsVerificationFailureOnce(`${ip}:${port}`);
      resolve(false);
    });
    req.end();
  });
}

@Injectable()
export class NetworkScanService {
  private readonly logger = new Logger(APP_CLASS_NAME);
  private readonly jobId: string;
  private readonly config: NetworkConfig;
  private readonly runner: Runner;
  private readonly ipmiPingFn: (ip: string) => Promise<boolean>;
  private readonly redfishCheckFn: (ip: string) => Promise<boolean>;
  private readonly localIpsProvider: (network: string) => Set<string>;
  private readonly gatewayIpProvider: (network: string) => Promise<string | null>;
  private readonly nmapDiscover: (network: string) => Promise<string[]>;

  constructor(jobId = '', deps: NetworkScanDeps = {}) {
    this.jobId = jobId;
    this.config = deps.config ?? getNetworkConfig();
    this.runner = deps.runner ?? (async (cmd, timeoutSeconds) => run(cmd, timeoutSeconds ?? 10));
    this.ipmiPingFn =
      deps.ipmiPingFn ??
      ((ip: string): Promise<boolean> =>
        ipmiPing(ip, {
          port: this.config.ipmiPort,
          timeout: this.config.ipmiTimeoutMs / 1000,
          jobId: this.jobId,
        }));
    this.redfishCheckFn = deps.redfishCheckFn ?? ((ip: string): Promise<boolean> => this.checkRedfish(ip));
    this.localIpsProvider = deps.localIpsProvider ?? ((network: string): Set<string> => this.getLocalIps(network));
    this.gatewayIpProvider =
      deps.gatewayIpProvider ?? ((network: string): Promise<string | null> => this.getGatewayIp(network));
    this.nmapDiscover = deps.nmapDiscover ?? ((network: string): Promise<string[]> => this.discoverHosts(network));
  }

  private logTag(): string {
    return `[${APP_CLASS_NAME}]${this.jobId ? ` job=${this.jobId}` : ''}`;
  }

  async scanNetworks(subnets: string[]): Promise<Record<string, SubnetScanOutput>> {
    try {
      this.logger.log(
        `Starting network scan for ${subnets.length} subnet(s): ${JSON.stringify(subnets)} ${this.logTag()}`,
      );

      this.logger.debug(`Validating CIDR subnet notations ${this.logTag()}`);
      const validationError = this.validateCidrSubnets(subnets);
      if (validationError !== null) {
        this.logger.error(`Subnet validation failed: ${validationError} ${this.logTag()}`);
        throw new NetworkScanValidationError(validationError);
      }

      this.logger.debug(`All subnets validated successfully ${this.logTag()}`);

      this.logger.debug(`Starting parallel subnet scanning ${this.logTag()}`);
      const settled = await Promise.allSettled(subnets.map((subnet) => this.scanSingleSubnet(subnet)));

      const output: Record<string, SubnetScanOutput> = {};
      subnets.forEach((subnet, idx) => {
        const outcome = settled[idx];
        if (outcome === undefined || outcome.status === 'rejected') {
          const reason =
            outcome !== undefined && outcome.status === 'rejected' ? getErrorMessage(outcome.reason) : 'missing result';
          this.logger.error(`Subnet ${subnet} scan failed: ${reason} ${this.logTag()}`);
          output[subnet] = { errored: true, results: {} };
          return;
        }
        const result = outcome.value;
        const hostResults: Record<string, HostResult> = {};
        for (const [ip, host] of result.results) {
          hostResults[ip] = { mac: host.mac, ipmi: host.ipmi, redfish: host.redfish };
        }
        output[subnet] = { errored: result.errored, results: hostResults };
      });

      const deviceCount = Object.values(output)
        .filter((net) => !net.errored)
        .reduce((acc, net) => acc + Object.keys(net.results).length, 0);
      this.logger.log(`Network scan completed successfully - discovered ${deviceCount} devices ${this.logTag()}`);

      return output;
    } catch (e) {
      if (e instanceof NetworkScanValidationError) throw e;
      const msg = getErrorMessage(e);
      this.logger.error(`Network scan operation failed: ${msg} ${this.logTag()}`);
      throw new NetworkScanError(`Network scan failed: ${msg}`);
    }
  }

  private validateCidrSubnets(subnets: string[]): string | null {
    for (const subnet of subnets) {
      this.logger.debug(`Validating CIDR notation for subnet: ${subnet} ${this.logTag()}`);
      const parsed = tryParseCidr(subnet);
      if (parsed === null) {
        const errorMsg = `Invalid CIDR notation '${subnet}': '${subnet}' does not appear to be an IPv4 or IPv6 network`;
        this.logger.debug(`CIDR validation failed: ${errorMsg} ${this.logTag()}`);
        return errorMsg;
      }
      this.logger.debug(`Subnet ${subnet} validated successfully ${this.logTag()}`);
    }

    this.logger.debug(`All ${subnets.length} subnets passed CIDR validation ${this.logTag()}`);
    return null;
  }

  private async scanSingleSubnet(subnet: string): Promise<SubnetScanResultInternal> {
    this.logger.log(`Starting scan for subnet ${subnet} ${this.logTag()}`);

    try {
      let hosts = await this.nmapDiscover(subnet);

      if (hosts.length === 0) {
        this.logger.debug(`No hosts discovered in ${subnet} ${this.logTag()}`);
        return { errored: false, results: new Map(), errorMessage: null };
      }

      this.logger.debug(`Discovered ${hosts.length} hosts in ${subnet} ${this.logTag()}`);

      const localIps = this.localIpsProvider(subnet);
      const gatewayIp = await this.gatewayIpProvider(subnet);
      const excluded = new Set(localIps);
      if (gatewayIp !== null) excluded.add(gatewayIp);
      const originalCount = hosts.length;
      hosts = hosts.filter((ip) => !excluded.has(ip));

      if (excluded.size > 0) {
        const removedCount = originalCount - hosts.length;
        if (removedCount > 0) {
          this.logger.log(
            `Removed ${removedCount} infrastructure IP(s) from results (local: ${JSON.stringify([...localIps].sort())}, gateway: ${gatewayIp ?? 'unknown'}) ${this.logTag()}`,
          );
        }
      }

      if (hosts.length === 0) {
        this.logger.debug(`No hosts remaining after local IP filtering in ${subnet} ${this.logTag()}`);
        return { errored: false, results: new Map(), errorMessage: null };
      }

      const macMap = await this.resolveMacs(hosts, subnet);

      const [ipmiMap, redfishMap] = await Promise.all([
        this.checkBatch(hosts, this.ipmiPingFn, 'IPMI'),
        this.checkBatch(hosts, this.redfishCheckFn, 'Redfish'),
      ]);

      const results = new Map<string, HostResult>();
      for (const ip of hosts) {
        results.set(ip, {
          mac: macMap[ip] ?? '',
          ipmi: ipmiMap[ip] ?? false,
          redfish: redfishMap[ip] ?? false,
        });
      }

      this.logger.log(`Subnet ${subnet} scan complete: ${results.size} hosts ${this.logTag()}`);

      return { errored: false, results, errorMessage: null };
    } catch (e) {
      const msg = getErrorMessage(e);
      if (e instanceof NetworkScanTimeoutError) {
        this.logger.error(`Subnet ${subnet} timed out: ${msg} ${this.logTag()}`);
      } else {
        this.logger.error(`Subnet ${subnet} scan failed: ${msg} ${this.logTag()}`);
      }
      return { errored: true, results: new Map(), errorMessage: msg };
    }
  }

  private async discoverHosts(network: string): Promise<string[]> {
    this.logger.debug(`Starting host discovery for ${network} ${this.logTag()}`);

    const cmd: string[] = ['nmap', '-sn', '-n'];
    if (this.config.nmapPrivileged) cmd.push('--send-ip', '-PE');
    // Redfish port must be in the SYN set: unprivileged scans would otherwise never discover a BMC that only answers on a non-standard Redfish port.
    const synPorts = [...new Set([22, 80, this.config.redfishPort])];
    cmd.push(`-PS${synPorts.join(',')}`);
    if (this.config.nmapPrivileged) cmd.push('-PU623');
    cmd.push(
      '--min-parallelism',
      String(this.config.nmapMinParallelism),
      '--min-rate',
      String(this.config.nmapMinRate),
      '--max-retries',
      String(this.config.nmapMaxRetries),
      '-oG',
      '-',
      network,
    );

    const parsed = tryParseCidr(network);
    const mask = parsed === null ? 0 : parsed.prefix;
    let timeout = this.config.defaultScanTimeout;
    if (mask >= 22 && mask < 24) {
      timeout *= 2;
    } else if (mask > 16 && mask < 22) {
      timeout *= 8;
    } else if (mask <= 16) {
      throw new NetworkScanError(`scans will not continue: /${mask} is too broad`);
    }

    let result: RunResultLike;
    try {
      result = await this.runner(cmd, timeout);
    } catch (e) {
      if (e instanceof CommandTimeout || (e instanceof Error && e.name === 'TimeoutError')) {
        this.logger.error(`Host discovery timed out for ${network} ${this.logTag()}`);
        throw new NetworkScanTimeoutError(`Host discovery timed out for ${network}`);
      }
      if (e instanceof CommandFailed) {
        this.logger.error(`nmap scan failed for ${network}: ${e.stderr} ${this.logTag()}`);
        throw new NetworkScanError(`nmap scan failed: ${e.stderr}`);
      }
      this.logger.error(`nmap scan failed for ${network}: ${getErrorMessage(e)} ${this.logTag()}`);
      throw new NetworkScanError(`nmap scan failed: ${getErrorMessage(e)}`);
    }

    if (result.exitCode !== 0) {
      this.logger.error(`nmap scan failed for ${network}: ${result.stderr} ${this.logTag()}`);
      throw new NetworkScanError(`nmap scan failed: ${result.stderr}`);
    }

    const hosts = parseNmapGreppableOutput(result.stdout);
    this.logger.debug(`Discovered ${hosts.length} hosts in ${network} ${this.logTag()}`);
    return hosts;
  }

  private getLocalIps(network: string): Set<string> {
    const localIps = new Set<string>();
    const targetNetwork = tryParseCidr(network);
    if (targetNetwork === null) return localIps;

    for (const [ifaceName, entries] of Object.entries(networkInterfaces())) {
      // Skip loopback: simulated BMCs may run on lo in local testing and must stay in results.
      if (ifaceName.startsWith('lo')) continue;

      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4') continue;
        if (cidrContains(targetNetwork, entry.address)) {
          localIps.add(entry.address);
          this.logger.debug(
            `Found local IP ${entry.address} in network ${network} on interface ${ifaceName} ${this.logTag()}`,
          );
        }
      }
    }

    return localIps;
  }

  private async getGatewayIp(network: string): Promise<string | null> {
    const targetNetwork = tryParseCidr(network);
    if (targetNetwork === null) return null;

    let result: RunResultLike;
    try {
      result = await this.runner(['ip', '-j', 'route', 'show', 'default'], 10);
    } catch (e) {
      this.logger.debug(`Failed to read gateways while scanning ${network}: ${getErrorMessage(e)} ${this.logTag()}`);
      return null;
    }

    if (result.exitCode !== 0) {
      this.logger.debug(`Failed to read gateways while scanning ${network}: ${result.stderr} ${this.logTag()}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout || '[]');
    } catch (e) {
      this.logger.debug(
        `Failed to parse ip route output while scanning ${network}: ${getErrorMessage(e)} ${this.logTag()}`,
      );
      return null;
    }
    if (!Array.isArray(parsed)) return null;

    for (const route of parsed) {
      if (!isRecord(route)) continue;
      const gw = typeof route['gateway'] === 'string' ? route['gateway'] : '';
      if (!gw) continue;
      if (cidrContains(targetNetwork, gw)) {
        this.logger.debug(`Resolved gateway ${gw} for subnet ${network} ${this.logTag()}`);
        return gw;
      }
    }
    return null;
  }

  private async resolveMacs(hosts: string[], network: string): Promise<Record<string, string>> {
    const hostsSet = new Set(hosts);
    let macMap: Record<string, string>;
    try {
      macMap =
        process.platform === 'darwin'
          ? await this.resolveMacsDarwin(hostsSet)
          : await this.resolveMacsLinux(hostsSet, network);
    } catch (e) {
      this.logger.error(`MAC resolution failed: ${getErrorMessage(e)} ${this.logTag()}`);
      macMap = {};
    }

    for (const ip of hosts) {
      if (!(ip in macMap)) macMap[ip] = '';
    }

    return macMap;
  }

  private async resolveMacsLinux(hostsSet: Set<string>, network: string): Promise<Record<string, string>> {
    let result: RunResultLike;
    try {
      result = await this.runner(['ip', '-j', 'neighbour', 'show', network], 30);
    } catch (e) {
      if (e instanceof CommandFailed) {
        this.logger.warn(`ip neighbour show failed (returncode ${e.exitCode}): ${e.stderr} ${this.logTag()}`);
        return {};
      }
      this.logger.warn(`ip neighbour show failed: ${getErrorMessage(e)} ${this.logTag()}`);
      return {};
    }

    if (result.exitCode !== 0) {
      this.logger.warn(`ip neighbour show failed (returncode ${result.exitCode}): ${result.stderr} ${this.logTag()}`);
      return {};
    }

    try {
      return parseIpNeighbourJson(result.stdout, hostsSet, this.logger, this.jobId);
    } catch (e) {
      this.logger.warn(`Failed to parse ip neighbour output: ${getErrorMessage(e)} ${this.logTag()}`);
      return {};
    }
  }

  private async resolveMacsDarwin(hostsSet: Set<string>): Promise<Record<string, string>> {
    let result: RunResultLike;
    try {
      result = await this.runner(['arp', '-an'], 30);
    } catch (e) {
      this.logger.warn(`arp -an failed: ${getErrorMessage(e)} ${this.logTag()}`);
      return {};
    }

    if (result.exitCode !== 0) {
      this.logger.warn(`arp -an failed (returncode ${result.exitCode}): ${result.stderr} ${this.logTag()}`);
      return {};
    }

    return parseArpAnOutput(result.stdout, hostsSet, this.logger, this.jobId);
  }

  private async checkRedfish(ip: string): Promise<boolean> {
    const timeoutMs = this.config.redfishTimeoutMs;
    const port = this.config.redfishPort;

    const tcpOk = await tcpConnect(ip, port, timeoutMs);
    if (!tcpOk) return false;

    return httpsRedfishProbe(ip, port, timeoutMs);
  }

  private async checkBatch(
    hosts: string[],
    checkFn: (ip: string) => Promise<boolean>,
    label: string,
  ): Promise<Record<string, boolean>> {
    const maxConcurrent = this.config.maxConcurrentScans;
    const results: Record<string, boolean> = {};

    for (let i = 0; i < hosts.length; i += maxConcurrent) {
      const batch = hosts.slice(i, i + maxConcurrent);
      const settled = await Promise.allSettled(batch.map((ip) => checkFn(ip)));

      batch.forEach((ip, idx) => {
        const outcome = settled[idx];
        if (outcome !== undefined && outcome.status === 'fulfilled') {
          results[ip] = outcome.value;
        } else {
          const reason =
            outcome !== undefined && outcome.status === 'rejected' ? getErrorMessage(outcome.reason) : 'missing result';
          this.logger.debug(`${label} check failed for ${ip}: ${reason} ${this.logTag()}`);
          results[ip] = false;
        }
      });
    }

    return results;
  }
}

export function createNetworkScanService(jobId = '', deps: NetworkScanDeps = {}): NetworkScanService {
  return new NetworkScanService(jobId, deps);
}
