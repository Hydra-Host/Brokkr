import { z } from 'zod';

const envSchema = z.object({
  BROKKR_ENV: z.string().optional(),
  HH_ENV: z.string().optional(),
  ENVIRONMENT: z.string().optional(),
  LOCAL_SIMULATION_ENABLED: z.string().optional(),
  SIM_REDFISH_PORT: z.string().optional(),
  REDFISH_TLS_VERIFY: z.string().optional(),
});

export interface RedfishConfig {
  brokkrEnv: string;
  localSimulationEnabled: boolean;
  simRedfishPort: number;
  tlsVerify: boolean;
}

export function buildRedfishConfig(env: NodeJS.ProcessEnv = process.env): RedfishConfig {
  const parsed = envSchema.parse(env);
  return {
    brokkrEnv: parsed.BROKKR_ENV ?? parsed.HH_ENV ?? parsed.ENVIRONMENT ?? '',
    localSimulationEnabled: (parsed.LOCAL_SIMULATION_ENABLED ?? 'false').toLowerCase() === 'true',
    simRedfishPort: Number.parseInt(parsed.SIM_REDFISH_PORT ?? '8443', 10),
    tlsVerify: (parsed.REDFISH_TLS_VERIFY ?? 'false').toLowerCase() === 'true',
  };
}

export function isRedfishTlsVerificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return buildRedfishConfig(env).tlsVerify;
}

export const redfishRejectUnauthorized = isRedfishTlsVerificationEnabled;

export function redfishTlsVerificationDisabledReason(_env: NodeJS.ProcessEnv = process.env): string {
  return 'REDFISH_TLS_VERIFY is not set';
}

export function redfishTlsVerificationDisabledMessage(host?: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = host ? ` for BMC ${host}` : '';
  return (
    `Redfish TLS certificate verification is DISABLED${target}; BMC credentials and responses are ` +
    `exposed to MITM on the OOB network. Verification is off because ${redfishTlsVerificationDisabledReason(env)}. ` +
    `Set REDFISH_TLS_VERIFY=true to enable verification for a CA-trusted BMC fleet.`
  );
}

let warnedTlsVerificationDisabled = false;
export function warnRedfishTlsVerificationDisabledOnce(
  log: (message: string) => void,
  host?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (warnedTlsVerificationDisabled) return;
  warnedTlsVerificationDisabled = true;
  log(redfishTlsVerificationDisabledMessage(host, env));
}

export function resetRedfishTlsVerificationDisabledWarningForTest(): void {
  warnedTlsVerificationDisabled = false;
}

const TLS_CERT_VERIFICATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function isTlsCertVerificationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && TLS_CERT_VERIFICATION_ERROR_CODES.has(code);
}

export function redfishTlsVerificationFailureHint(host?: string): string {
  const target = host ? ` to BMC ${host}` : '';
  return (
    `Redfish TLS certificate verification failed${target}. ` +
    'Install a trusted CA on the BMC, or unset REDFISH_TLS_VERIFY to disable verification.'
  );
}

export function getBrokkrEnv(env: NodeJS.ProcessEnv = process.env): string {
  return buildRedfishConfig(env).brokkrEnv;
}

export function isLocalSimulationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return buildRedfishConfig(env).localSimulationEnabled;
}

export function getSimRedfishPort(env: NodeJS.ProcessEnv = process.env): number {
  return buildRedfishConfig(env).simRedfishPort;
}
