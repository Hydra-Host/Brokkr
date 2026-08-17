import type { RegistryRedis } from '../bridge-network/bridge-registry-reader.js';

export class DhcpRegistryRedisNotBoundError extends Error {
  constructor() {
    super(
      'DHCP registry redis holder not populated; AppModule must call setDhcpRegistryRedis ' +
        'via an OnApplicationBootstrap hook before the DHCP daemon reconciles opt-6 peer IPs.',
    );
    this.name = 'DhcpRegistryRedisNotBoundError';
  }
}

let redis: RegistryRedis | null = null;

export function setDhcpRegistryRedis(value: RegistryRedis): void {
  redis = value;
}

export function isDhcpRegistryRedisBound(): boolean {
  return redis !== null;
}

export function getDhcpRegistryRedisOrThrow(): RegistryRedis {
  if (redis === null) {
    throw new DhcpRegistryRedisNotBoundError();
  }
  return redis;
}

export function resetDhcpRegistryRedisForTests(): void {
  redis = null;
}
