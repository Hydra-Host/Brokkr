import { isIP } from 'node:net';

const IPV4_PREFIX = 'ipv4:';
const IPV6_PREFIX = 'ipv6:';

export type PeerMetadataReader = (key: string) => readonly unknown[];

export function parsePeerIp(peer: unknown, metadata?: PeerMetadataReader): string | null {
  const socketIp = parseSocketPeerIp(peer);
  if (socketIp === null || !isLoopbackIp(socketIp) || metadata === undefined) return socketIp;

  const realIp = firstValidIp(metadata('x-real-ip'));
  if (realIp !== null) return realIp;

  for (const value of metadata('x-forwarded-for')) {
    if (typeof value !== 'string') continue;
    // Rightmost entry: appended by the trusted local proxy; leftmost is client-supplied and spoofable.
    const forwardedIp = firstValidIp(value.split(',').reverse());
    if (forwardedIp !== null) return forwardedIp;
  }
  return socketIp;
}

function parseSocketPeerIp(peer: unknown): string | null {
  if (typeof peer !== 'string' || peer === '') return null;

  if (peer.startsWith(IPV4_PREFIX)) {
    const rest = peer.slice(IPV4_PREFIX.length);
    const idx = rest.lastIndexOf(':');
    if (idx === -1) return null;
    const ip = rest.slice(0, idx);
    return ip === '' ? null : ip;
  }

  if (peer.startsWith(IPV6_PREFIX)) {
    const rest = peer.slice(IPV6_PREFIX.length);
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']:');
      if (close !== -1) return rest.slice(1, close);
    }
  }

  return null;
}

function firstValidIp(values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const ip = value.trim();
    if (isIP(ip) !== 0) return ip;
  }
  return null;
}

function isLoopbackIp(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (!ip.toLowerCase().startsWith('::ffff:')) return false;
  return ip.slice('::ffff:'.length).startsWith('127.');
}
