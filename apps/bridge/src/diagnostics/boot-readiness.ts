import { z } from 'zod';

import { getErrorMessage } from '../common/error-utils.js';
import { getDhcpStandbyHealth } from '../composition/dhcp-standby-health-holder.js';
import type { DhcpConfigReaderService } from '../dhcp/dhcp-config-reader.service.js';
import type { DhcpStandbyHealth } from '../dhcp/dhcp-manager.service.js';
import type { DhcpMode } from '../dhcp/dhcp.config.js';
import type { DnsConfigReaderService } from '../dns/dns-config-reader.service.js';
import { getDiscoveryFileConfig } from '../download/discovery.config.js';
import { getIpxeConfig } from '../ipxe/ipxe.config.js';
import { logWarning } from '../logger/logger.service.js';
import { evaluateChainReachability } from '../startup/chain-reachability-assert.js';
import { evaluateDiscoveryImages } from '../startup/discovery-image-assert.js';
import { realFileExists, realReadTextFile } from '../startup/fs-io.js';
import { evaluateIpxeBuilds, type FileExists, type ReadTextFile } from '../startup/ipxe-build-assert.js';
import { resolveListenHost } from '../startup/listen-target.js';
import { getStorageConfig } from '../sync/sync.config.js';
import { IPXE_VALID_ARCHES } from '../tftp/tftp-dyn-file.js';
import { getTftpConfig } from '../tftp/tftp.config.js';

import { BOOT_SEVERITIES, bootCodeSpec, type BootCode, type BootFinding, type BootSeverity } from '@repo/utils';

/** Emitted in place of a check's findings when its subject was unreachable, so the result is unknown, never a pass. */
export const UNEVALUATED_CODE = 'PXE-107';

export const BOOT_READINESS_CHECKS = Symbol('BOOT_READINESS_CHECKS');

export interface BootReadinessCheck {
  name: string;
  /** Null means the subject could not be reached; an empty array means it was reached and is clear. */
  run: () => Promise<readonly BootFinding[] | null>;
}

export type BootReadinessCheckFactory = (jobId: string) => BootReadinessCheck[];

export interface BootReadinessCounts {
  error: number;
  warn: number;
  unevaluated: number;
}

export interface BootReadinessReport {
  findings: Array<{ code: string; severity: BootSeverity }>;
  counts: BootReadinessCounts;
}

const severitySchema = z.enum(BOOT_SEVERITIES);

export const bootReadinessResponseSchema = z.object({
  findings: z
    .array(
      z.object({
        code: z.string().describe('Boot diagnostic code from the BOOT_CODES registry, e.g. PXE-01.'),
        severity: severitySchema.describe(
          'Severity this occurrence carries, which may be softer than the registry default.',
        ),
      }),
    )
    .describe('One entry per condition found; codes only, because this route is unauthenticated.'),
  counts: z
    .object({
      error: z.number().int().nonnegative().describe('Findings of error severity.'),
      warn: z.number().int().nonnegative().describe('Findings of warn severity, PXE-107 included.'),
      unevaluated: z
        .number()
        .int()
        .nonnegative()
        .describe('Checks whose subject was unreachable, so neither pass nor fail.'),
    })
    .describe('Roll-up of the findings above, where info-severity findings are listed but not counted.'),
});

export type BootReadinessResponse = z.infer<typeof bootReadinessResponseSchema>;

export function countBootFindings(findings: readonly { code: string; severity: BootSeverity }[]): BootReadinessCounts {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    unevaluated: findings.filter((f) => f.code === UNEVALUATED_CODE).length,
  };
}

export async function evaluateBootReadiness(checks: readonly BootReadinessCheck[]): Promise<BootReadinessReport> {
  const findings: BootReadinessReport['findings'] = [];

  for (const check of checks) {
    let produced: readonly BootFinding[] | null;
    try {
      produced = await check.run();
    } catch (error) {
      // an unexpected throw is indistinguishable from the designed null path on the wire, so log the cause here
      await logWarning(`Boot readiness check "${check.name}" threw: ${getErrorMessage(error)}`, {
        appClassName: 'boot-readiness',
      });
      produced = null;
    }

    if (produced === null) {
      findings.push({ code: UNEVALUATED_CODE, severity: bootCodeSpec(UNEVALUATED_CODE).severity });
      continue;
    }
    for (const finding of produced) findings.push({ code: finding.code, severity: finding.severity });
  }

  return { findings, counts: countBootFindings(findings) };
}

export interface BootReadinessLiveDeps {
  dhcp: Pick<DhcpConfigReaderService, 'readAll'>;
  dns: Pick<DnsConfigReaderService, 'readZoneConfig'>;
  fileExists?: FileExists;
  readTextFile?: ReadTextFile;
  jobId?: string;
  standby?: () => DhcpStandbyHealth | null;
}

function finding(code: BootCode, message: string): BootFinding {
  return { code, severity: bootCodeSpec(code).severity, message };
}

// PXE-07 only skips PROXY, so a zone mixing modes must not read as PROXY.
function summarizeDhcpMode(modes: readonly DhcpMode[]): DhcpMode {
  if (modes.includes('AUTHORITATIVE')) return 'AUTHORITATIVE';
  if (modes.includes('PROXY')) return 'PROXY';
  return 'OFF';
}

/** The three startup evaluators re-run against live atom and filesystem state, so a result may differ from the boot log. */
export function buildLiveBootReadinessChecks(deps: BootReadinessLiveDeps): BootReadinessCheck[] {
  const jobId = deps.jobId ?? '';
  const fileExists = deps.fileExists ?? realFileExists;
  const standby = deps.standby ?? getDhcpStandbyHealth;
  const readTextFile = deps.readTextFile ?? realReadTextFile;
  // one read shared by both dhcp checks, scoped to this builder call so every evaluation reads fresh state
  let dhcpRead: ReturnType<typeof deps.dhcp.readAll> | undefined;
  const readDhcp = () => (dhcpRead ??= deps.dhcp.readAll(jobId));

  return [
    {
      name: 'chain_reachability',
      run: async () => {
        const dhcp = await readDhcp();
        if (!dhcp.ok) return null;
        const dns = await deps.dns.readZoneConfig(jobId);
        if (!dns.ok && dns.reason === 'error') return null;

        const modes = [...dhcp.configs.values()].map((config) => config.mode);
        return evaluateChainReachability({
          bridgeUrl: getIpxeConfig().bridgeUrl,
          listenHost: resolveListenHost(),
          dnsEnabled: dns.ok ? dns.config.enabled : false,
          // a prefix that serves DHCP always emits option 6: its own dnsServers, or the bridge itself (dnsSelf)
          dnsAdvertised: modes.some((mode) => mode !== 'OFF'),
          tlsTerminated: (process.env.BRIDGE_TLS_TERMINATED ?? '').trim().toLowerCase() === 'true',
          dhcpMode: summarizeDhcpMode(modes),
        });
      },
    },
    {
      name: 'ipxe_builds',
      // the startup assert skips this check entirely with tftp off, so both readiness surfaces must agree
      run: async () => {
        if (!getTftpConfig().tftpEnabled) return [];
        return evaluateIpxeBuilds(
          {
            finalBuildsDir: getIpxeConfig().finalBuildsDir,
            architectures: [...IPXE_VALID_ARCHES],
            bridgeUrl: getIpxeConfig().bridgeUrl,
          },
          fileExists,
          readTextFile,
        );
      },
    },
    {
      name: 'discovery_images',
      run: () =>
        evaluateDiscoveryImages(
          {
            discoveryDir: getStorageConfig().brokkrLiveHttpsDir,
            flavors: getDiscoveryFileConfig().flavors,
            architectures: getDiscoveryFileConfig().architectures,
          },
          fileExists,
        ),
    },
    {
      name: 'dhcp_answering',
      run: async () => {
        const dhcp = await readDhcp();
        if (!dhcp.ok) return null;
        const modes = [...dhcp.configs.values()].map((config) => config.mode);
        if (!modes.some((mode) => mode !== 'OFF')) return [];
        const health = standby();
        if (health === null) {
          return [finding(UNEVALUATED_CODE, 'DHCP engine state is not available, so answering cannot be evaluated.')];
        }
        const out: BootFinding[] = [];
        if (!health.answering) {
          out.push(
            finding(
              'PXE-105',
              `A serving DHCP mode is configured but this bridge is not answering (leader=${health.isLeader}, hydrated=${health.hydrated}).`,
            ),
          );
        }
        if (modes.includes('PROXY') && !health.pxePortBound) {
          out.push(finding('PXE-105', 'PROXY mode is configured but the udp/4011 boot-service socket is not bound.'));
        }
        return out;
      },
    },
  ];
}
