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

export interface ChainReachabilityFinding {
  code: 'PXE-07' | 'PXE-01/02';
  severity: 'error' | 'warn';
  message: string;
}

function parseBridgeUrl(bridgeUrl: string): { scheme: string; host: string } | null {
  try {
    const url = new URL(bridgeUrl);
    return { scheme: url.protocol.replace(/:$/, '').toLowerCase(), host: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

export function evaluateChainReachability(input: ChainReachabilityInput): ChainReachabilityFinding[] {
  const findings: ChainReachabilityFinding[] = [];
  const parsed = parseBridgeUrl(input.bridgeUrl);
  if (parsed === null) {
    findings.push({
      code: 'PXE-01/02',
      severity: 'error',
      message:
        `BRIDGE_URL=${JSON.stringify(input.bridgeUrl)} is not a valid absolute URL; the iPXE chain ` +
        'cannot be advertised. Set BRIDGE_URL to e.g. https://brokkr.lan or http://brokkr.lan:8080.',
    });
    return findings;
  }

  // PXE-07 skips PROXY mode by design: PROXY never emits option 6 (the external authoritative DHCP owns it).
  if (parsed.host === CHAIN_HOST && input.dhcpMode !== 'PROXY') {
    if (!input.dnsAdvertised && input.dnsEnabled) {
      findings.push({
        code: 'PXE-07',
        severity: 'error',
        message:
          `BRIDGE_URL advertises the ${CHAIN_HOST} iPXE chain, but ${CHAIN_HOST} is not resolvable: ` +
          `the bridge DNS server is running (hub zone DNS enabled) but no resolver is advertised to ` +
          `clients. Enable per-prefix DNS in the hub UI (leave the prefix dnsServers empty so the ` +
          `bridge advertises itself), or set BRIDGE_URL to an IP/host that resolves without ` +
          `${CHAIN_HOST}. Booting devices will loop forever resolving ${CHAIN_HOST}.`,
      });
    } else if (!input.dnsAdvertised && !input.dnsEnabled) {
      // Neither DNS proxy nor advertisement — at startup this looks broken, but
      // hub atoms may enable per-prefix DNS at runtime, so downgrade to WARN.
      findings.push({
        code: 'PXE-07',
        severity: 'warn',
        message:
          `BRIDGE_URL advertises the ${CHAIN_HOST} iPXE chain, but DNS is currently off ` +
          `and no prefix advertises a resolver to clients. ${CHAIN_HOST} will be unresolvable ` +
          `unless hub atoms enable DNS at runtime. Enable zone DNS in the hub UI, or set ` +
          `BRIDGE_URL to an IP/host that resolves without ${CHAIN_HOST}.`,
      });
    } else if (input.dnsAdvertised && !input.dnsEnabled) {
      // Hub says advertise DNS but the bridge proxy is off — clients get a DNS
      // option pointing nowhere.
      findings.push({
        code: 'PXE-07',
        severity: 'warn',
        message:
          `BRIDGE_URL advertises the ${CHAIN_HOST} iPXE chain and DNS is advertised to ` +
          `clients (per-prefix hub config) but the bridge DNS server is off; ${CHAIN_HOST} ` +
          `will resolve only if that external resolver has a ${CHAIN_HOST} record. Verify the ` +
          `upstream resolver, or enable zone DNS in the hub UI.`,
      });
    }
  }

  if (parsed.scheme === 'https' && !input.tlsTerminated) {
    findings.push({
      code: 'PXE-01/02',
      severity: 'error',
      message:
        `BRIDGE_URL scheme is https (implicit :443) but the bridge serves PLAIN HTTP on HOST=` +
        `${JSON.stringify(input.listenHost)} with no declared :443 TLS terminator, so the DNS-returned ` +
        'client-facing IP has no https listener. After DNS resolves, the iPXE chain GET hits a refused ' +
        'connection. Required invariant: front the bridge with a :443 TLS terminator (declare it via ' +
        'BRIDGE_TLS_TERMINATED=true), or set BRIDGE_URL=http://brokkr.lan:8080.',
    });
  }

  return findings;
}

export function assertChainReachability(
  input: ChainReachabilityInput,
  logger: StartupLogger,
  options: { strict?: boolean; jobId?: string } = {},
): void {
  const findings = evaluateChainReachability(input);
  if (findings.length === 0) return;

  const errors = findings.filter((f) => f.severity === 'error');
  for (const finding of findings) {
    const log = finding.severity === 'error' ? logger.error : logger.warn;
    log(`[chain-reachability ${finding.code}] ${finding.message}`, { jobId: options.jobId ?? '' });
  }
  if (options.strict && errors.length > 0) {
    throw new Error(
      `Chain reachability assertion failed (${errors.map((f) => f.code).join(', ')}); ` +
        'BRIDGE_CHAIN_REACHABILITY_STRICT=true. See logged errors above.',
    );
  }
}
