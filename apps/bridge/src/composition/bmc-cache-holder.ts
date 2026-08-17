import type { DeviceCredentialResolverCache } from './device-cred-resolver-factory.js';

export class BmcCacheNotBoundError extends Error {
  constructor() {
    super(
      'BMC credentials cache holder not populated; AppModule must call setBmcCache ' +
        'via an OnApplicationBootstrap hook before any DeviceCredentialResolver consumer fires.',
    );
    this.name = 'BmcCacheNotBoundError';
  }
}

let cache: DeviceCredentialResolverCache | null = null;

export function setBmcCache(value: DeviceCredentialResolverCache): void {
  cache = value;
}

export function getBmcCacheOrThrow(): DeviceCredentialResolverCache {
  if (cache === null) {
    throw new BmcCacheNotBoundError();
  }
  return cache;
}

export function resetBmcCacheForTests(): void {
  cache = null;
}
