import { z } from 'zod';
import { envInt } from '../common/env-utils';

const envSchema = z.object({
  NETWORK_MAX_CONCURRENT_SCANS: envInt(10),
  NETWORK_DEFAULT_SCAN_TIMEOUT: envInt(60),
  NETWORK_IPMI_TIMEOUT_MS: envInt(750),
  NETWORK_IPMI_PORT: envInt(623),
  NETWORK_REDFISH_TIMEOUT_MS: envInt(4000),
  NETWORK_NMAP_PARALLELISM: envInt(100),
  NETWORK_NMAP_RATE: envInt(256),
  NETWORK_NMAP_RETRIES: envInt(1),
  NETWORK_NMAP_PRIVILEGED: z.string().optional(),
  LOCAL_SIMULATION_ENABLED: z.string().optional(),
});

export interface NetworkConfig {
  maxConcurrentScans: number;
  defaultScanTimeout: number;
  ipmiTimeoutMs: number;
  ipmiPort: number;
  redfishTimeoutMs: number;
  nmapMinParallelism: number;
  nmapMinRate: number;
  nmapMaxRetries: number;
  nmapPrivileged: boolean;
}

export function buildNetworkConfig(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const parsed = envSchema.parse(env);
  const simEnabled = (parsed.LOCAL_SIMULATION_ENABLED ?? '').toLowerCase() === 'true';
  const nmapPrivileged =
    parsed.NETWORK_NMAP_PRIVILEGED !== undefined
      ? parsed.NETWORK_NMAP_PRIVILEGED.toLowerCase() === 'true'
      : !simEnabled;
  return {
    maxConcurrentScans: parsed.NETWORK_MAX_CONCURRENT_SCANS,
    defaultScanTimeout: parsed.NETWORK_DEFAULT_SCAN_TIMEOUT,
    ipmiTimeoutMs: parsed.NETWORK_IPMI_TIMEOUT_MS,
    ipmiPort: parsed.NETWORK_IPMI_PORT,
    redfishTimeoutMs: parsed.NETWORK_REDFISH_TIMEOUT_MS,
    nmapMinParallelism: parsed.NETWORK_NMAP_PARALLELISM,
    nmapMinRate: parsed.NETWORK_NMAP_RATE,
    nmapMaxRetries: parsed.NETWORK_NMAP_RETRIES,
    nmapPrivileged,
  };
}

let cached: NetworkConfig | null = null;

export function getNetworkConfig(): NetworkConfig {
  if (cached === null) {
    cached = buildNetworkConfig();
  }
  return cached;
}

export function resetNetworkConfigForTests(): void {
  cached = null;
}
