import type { RedisLeaseCache } from '../dhcp/lease-store/redis-lease-store.js';

export class DhcpLeaseCacheNotBoundError extends Error {
  constructor() {
    super(
      'DHCP lease cache holder not populated; AppModule must call setDhcpLeaseCache ' +
        'via an OnApplicationBootstrap hook before the DHCP daemon acquires leadership.',
    );
    this.name = 'DhcpLeaseCacheNotBoundError';
  }
}

let cache: RedisLeaseCache | null = null;
let disposer: (() => void) | null = null;

export function setDhcpLeaseCache(value: RedisLeaseCache, dispose?: () => void): void {
  disposer?.();
  cache = value;
  disposer = dispose ?? null;
}

export function isDhcpLeaseCacheBound(): boolean {
  return cache !== null;
}

export function getDhcpLeaseCacheOrThrow(): RedisLeaseCache {
  if (cache === null) {
    throw new DhcpLeaseCacheNotBoundError();
  }
  return cache;
}

export function resetDhcpLeaseCacheForTests(): void {
  disposer?.();
  disposer = null;
  cache = null;
}
