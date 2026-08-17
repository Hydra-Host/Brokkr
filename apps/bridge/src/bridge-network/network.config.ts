import { z } from 'zod';

const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

const envInt = (def: number) =>
  z
    .union([z.string(), z.undefined()])
    .transform((value, ctx) => {
      if (value === undefined) return def;
      if (!STRICT_INT_PATTERN.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return Number.parseInt(value.replace(/_/g, ''), 10);
    })
    .pipe(z.number().int());

const envSchema = z.object({
  NETWORK_MAX_CONCURRENT_SCANS: envInt(10),
  NETWORK_DEFAULT_SCAN_TIMEOUT: envInt(60),
  NETWORK_IPMI_TIMEOUT_MS: envInt(100),
  NETWORK_IPMI_PORT: envInt(623),
  NETWORK_REDFISH_TIMEOUT_MS: envInt(2000),
  NETWORK_REDFISH_PORT: envInt(443),
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
  redfishPort: number;
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
    redfishPort: parsed.NETWORK_REDFISH_PORT,
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
