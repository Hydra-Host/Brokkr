import { isIPv4 } from 'node:net';

import { ipInCidr, isRoutableUnicastIpv4 } from '@repo/utils';

import { getErrorMessage } from '../common/error-utils';
import { getLogger } from '../logger/logger.service';
import {
  discoverIpv4Interfaces,
  egressSourceIp,
  isClientFacingName,
  type NetworkInterface,
} from './bridge-ip-resolution.service';

export const PEER_ANCHOR_TTL_MS = 5 * 60 * 1000;

const V4_MAPPED_PREFIX = '::ffff:';

export interface PeerAnchorPort {
  resolve(peerIp: string): Promise<string | null>;
}

export interface PeerAnchorResolverDeps {
  interfaceDiscovery?: () => NetworkInterface[];
  egressSourceIpFn?: (targetIp: string) => Promise<string | null>;
  now?: () => number;
}

export function stripV4MappedPrefix(ip: string): string {
  if (!ip.toLowerCase().startsWith(V4_MAPPED_PREFIX)) return ip;
  const inner = ip.slice(V4_MAPPED_PREFIX.length);
  return isIPv4(inner) ? inner : ip;
}

// Anchors come only from this process's live interfaces: the Redis interface cache is shared by every bridge in the zone.
export class PeerAnchorResolver implements PeerAnchorPort {
  private readonly interfaceDiscovery: () => NetworkInterface[];
  private readonly egressSourceIpFn: (targetIp: string) => Promise<string | null>;
  private readonly now: () => number;
  private readonly cache = new Map<string, { anchor: string; expiresAt: number }>();

  constructor(deps: PeerAnchorResolverDeps = {}) {
    this.interfaceDiscovery = deps.interfaceDiscovery ?? discoverIpv4Interfaces;
    this.egressSourceIpFn = deps.egressSourceIpFn ?? egressSourceIp;
    this.now = deps.now ?? ((): number => Date.now());
  }

  async resolve(peerIp: string): Promise<string | null> {
    try {
      const ip = stripV4MappedPrefix(peerIp);
      const hit = this.cache.get(ip);
      if (hit !== undefined && hit.expiresAt > this.now()) return hit.anchor;
      this.cache.delete(ip);

      const anchor = await this.lookup(ip);
      if (anchor !== null) this.cache.set(ip, { anchor, expiresAt: this.now() + PEER_ANCHOR_TTL_MS });
      return anchor;
    } catch (error) {
      void getLogger().warning(`peer anchor resolution failed for ${peerIp}: ${getErrorMessage(error)}`);
      return null;
    }
  }

  private async lookup(ip: string): Promise<string | null> {
    if (!isIPv4(ip)) return null;
    const interfaces = this.interfaceDiscovery();

    const direct = interfaces.find(
      (iface) => isClientFacingName(iface.name) && isRoutableUnicastIpv4(iface.ip) && ipInCidr(ip, iface.network),
    );
    if (direct !== undefined) return direct.ip;

    const source = await this.egressSourceIpFn(ip);
    if (source === null || !isRoutableUnicastIpv4(source)) return null;
    return interfaces.some((iface) => iface.ip === source) ? source : null;
  }
}
