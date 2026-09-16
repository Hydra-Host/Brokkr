import { type BootFinding, bootCodeSpec } from '@repo/utils';

import type { StartupLogger } from './startup-deps.types.js';

const CHAIN_HOST = 'brokkr.lan';

export interface ChainReachabilityInput {
  bridgeUrl: string;
  listenHost: string;
  dnsEnabled: boolean;
  dnsAdvertised: boolean;
  tlsTerminated: boolean;
  dhcpMode: 'AUTHORITATIVE' | 'PROXY' | 'OFF';
}

function parseBridgeUrl(bridgeUrl: string): { scheme: string; host: string } | null {
  try {
    const url = new URL(bridgeUrl);
    return { scheme: url.protocol.replace(/:$/, '').toLowerCase(), host: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

export function evaluateChainReachability(input: ChainReachabilityInput): BootFinding[] {
  const findings: BootFinding[] = [];
  const address = bootCodeSpec('PXE-02');
  const resolution = bootCodeSpec('PXE-07');

  const parsed = parseBridgeUrl(input.bridgeUrl);
  if (parsed === null) {
    findings.push({
      code: 'PXE-02',
      severity: address.severity,
      message:
        `${address.title}: BRIDGE_URL=${JSON.stringify(input.bridgeUrl)} is not a valid absolute URL, ` +
        `so the iPXE chain cannot be advertised. ${address.remedy}`,
    });
    return findings;
  }

  // PXE-07 skips PROXY mode by design: PROXY never emits option 6 (the external authoritative DHCP owns it).
  if (parsed.host === CHAIN_HOST && input.dhcpMode !== 'PROXY') {
    if (!input.dnsAdvertised && input.dnsEnabled) {
      findings.push({
        code: 'PXE-07',
        severity: resolution.severity,
        message:
          `${resolution.title}: BRIDGE_URL advertises the ${CHAIN_HOST} chain and the bridge DNS server ` +
          `is running, but no prefix advertises a resolver to clients, so booting devices loop forever ` +
          `resolving ${CHAIN_HOST}. ${resolution.remedy}`,
      });
    } else if (!input.dnsAdvertised && !input.dnsEnabled) {
      // hub atoms may enable per-prefix DNS at runtime, so a startup-time absence is a warn, not an error
      findings.push({
        code: 'PXE-07',
        severity: 'warn',
        message:
          `${resolution.title}: BRIDGE_URL advertises the ${CHAIN_HOST} chain, DNS is off and no prefix ` +
          `advertises a resolver, so ${CHAIN_HOST} is unresolvable unless hub atoms enable DNS at ` +
          `runtime. ${resolution.remedy}`,
      });
    } else if (input.dnsAdvertised && !input.dnsEnabled) {
      // the advertised resolver is external, so the record may still exist upstream
      findings.push({
        code: 'PXE-07',
        severity: 'warn',
        message:
          `${resolution.title}: BRIDGE_URL advertises the ${CHAIN_HOST} chain and a resolver is advertised ` +
          `to clients, but the bridge DNS server is off, so ${CHAIN_HOST} resolves only if that upstream ` +
          `resolver carries the record. ${resolution.remedy}`,
      });
    }
  }

  if (parsed.scheme === 'https' && !input.tlsTerminated) {
    findings.push({
      code: 'PXE-02',
      severity: address.severity,
      message:
        `${address.title}: BRIDGE_URL scheme is https (implicit :443) but the bridge serves plain HTTP on ` +
        `HOST=${JSON.stringify(input.listenHost)} with no declared :443 TLS terminator, so the chain GET ` +
        `hits a refused connection. Front the bridge with a :443 terminator and declare it via ` +
        `BRIDGE_TLS_TERMINATED=true, or switch BRIDGE_URL to an http:// address on the bridge provisioning NIC.`,
    });
  }

  return findings;
}

export function assertChainReachability(
  input: ChainReachabilityInput,
  logger: StartupLogger,
  options: { strict?: boolean; jobId?: string } = {},
): BootFinding[] {
  const findings = evaluateChainReachability(input);
  if (findings.length === 0) return findings;

  const errors = findings.filter((f) => f.severity === 'error');
  for (const finding of findings) {
    const log = finding.severity === 'error' ? logger.error : logger.warn;
    log(`[${finding.code}] ${finding.message}`, { jobId: options.jobId ?? '' });
  }
  if (options.strict && errors.length > 0) {
    throw new Error(
      `Chain reachability assertion failed (${errors.map((f) => f.code).join(', ')}); ` +
        'BRIDGE_CHAIN_REACHABILITY_STRICT=true. See logged errors above.',
    );
  }
  return findings;
}
