import { networkInterfaces } from 'node:os';

import { logError } from '../logger/logger.service';

import type { ActiveBridgeIpsProvider } from './netplan-to-kernel-params.service';

export function getLocalIpv4Addresses(): string[] {
  const ips: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') continue;
      ips.push(entry.address);
    }
  }
  return ips;
}

export function createDefaultActiveBridgeIpsProvider(
  discover: () => string[] = getLocalIpv4Addresses,
): ActiveBridgeIpsProvider {
  return {
    async getActiveBridgeIps(jobId: string): Promise<string[]> {
      try {
        return discover();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logError(`Failed to get active bridge IPs: ${message}`, { jobId });
        return [];
      }
    },
  };
}
