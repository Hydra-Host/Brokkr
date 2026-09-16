import { join } from 'node:path';

import { z } from 'zod';

import { type BootFinding, bootCodeSpec } from '@repo/utils';

import type { StartupLogger } from './startup-deps.types.js';

export const IPXE_BUILD_TARGETS = ['snponly', 'ipxe', 'snp'] as const;
export const IPXE_BUILD_EXT = 'efi';
export const IPXE_BUILD_FILENAMES = IPXE_BUILD_TARGETS.map((target) => `${target}.${IPXE_BUILD_EXT}`);

// written beside the binaries by the iPXE bake (apps/local-sim/scripts/local/ipxe_build.py)
export const IPXE_CHAIN_STAMP_FILENAME = '.chain-stamp.json';

const ChainStampSchema = z.object({ chain_base_url: z.string() });

export interface IpxeBuildInput {
  finalBuildsDir: string;
  architectures: readonly string[];
  bridgeUrl: string;
}

export type FileExists = (path: string) => Promise<boolean>;
/** Resolves null when the path is absent or unreadable, so the evaluator itself stays free of I/O branching. */
export type ReadTextFile = (path: string) => Promise<string | null>;

function hostOf(url: string): string | null {
  let host: string;
  try {
    // `brokkr.lan:8000` parses as a scheme with an empty host, so emptiness is the real usability test.
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return host === '' ? null : host;
}

function readChainStamp(raw: string | null): { url: string; host: string } | null {
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const stamp = ChainStampSchema.safeParse(decoded);
  if (!stamp.success) return null;
  const host = hostOf(stamp.data.chain_base_url);
  return host === null ? null : { url: stamp.data.chain_base_url, host };
}

async function evaluateBakeStamp(input: IpxeBuildInput, readTextFile: ReadTextFile): Promise<BootFinding[]> {
  const bridgeHost = hostOf(input.bridgeUrl);
  if (bridgeHost === null) {
    const unevaluated = bootCodeSpec('PXE-107');
    return [
      {
        code: 'PXE-107',
        severity: unevaluated.severity,
        message:
          `${unevaluated.title}: the baked iPXE chain host cannot be compared because ` +
          `BRIDGE_URL=${JSON.stringify(input.bridgeUrl)} is not a valid absolute URL, so this check is ` +
          `unknown rather than passing. Fix BRIDGE_URL (see PXE-02) and restart the bridge.`,
      },
    ];
  }

  const stampPath = join(input.finalBuildsDir, IPXE_CHAIN_STAMP_FILENAME);
  const stamp = readChainStamp(await readTextFile(stampPath));
  if (stamp === null) {
    const absent = bootCodeSpec('PXE-108');
    return [
      {
        code: 'PXE-108',
        severity: absent.severity,
        message:
          `${absent.title}: ${stampPath} is absent or carries no usable chain_base_url, so the host baked ` +
          `into the binaries under ${input.finalBuildsDir} is unknown and may not be ${bridgeHost}. A machine ` +
          `that chainloads a host it cannot reach retries and drops to an iPXE shell. ${absent.remedy}`,
      },
    ];
  }

  if (stamp.host !== bridgeHost) {
    const mismatch = bootCodeSpec('PXE-109');
    return [
      {
        code: 'PXE-109',
        severity: mismatch.severity,
        message:
          `${mismatch.title}: the binaries under ${input.finalBuildsDir} chain to ${stamp.url} (host ` +
          `${stamp.host}) but BRIDGE_URL points at host ${bridgeHost}, so a booting machine asks ` +
          `${stamp.host} for the chain, cannot reach it, retries and drops to an iPXE shell. ${mismatch.remedy}`,
      },
    ];
  }

  return [];
}

export async function evaluateIpxeBuilds(
  input: IpxeBuildInput,
  fileExists: FileExists,
  readTextFile: ReadTextFile,
): Promise<BootFinding[]> {
  const findings: BootFinding[] = [];
  const spec = bootCodeSpec('PXE-01');
  for (const arch of input.architectures) {
    const dir = join(input.finalBuildsDir, arch);
    let satisfied = false;
    for (const filename of IPXE_BUILD_FILENAMES) {
      if (await fileExists(join(dir, filename))) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      findings.push({
        code: 'PXE-01',
        severity: spec.severity,
        message:
          `${spec.title}: arch=${arch} has none of ${IPXE_BUILD_FILENAMES.join(' / ')} under ${dir}, so the ` +
          `TFTP resolver has nothing to map the firmware bootfile to and a PXE boot NAKs (FileNotFound) ` +
          `before iPXE loads. ${spec.remedy}`,
      });
    }
  }
  findings.push(...(await evaluateBakeStamp(input, readTextFile)));
  return findings;
}

export async function assertIpxeBuilds(
  input: IpxeBuildInput,
  fileExists: FileExists,
  readTextFile: ReadTextFile,
  logger: StartupLogger,
  options: { strict?: boolean; jobId?: string; tftpEnabled?: boolean } = {},
): Promise<BootFinding[]> {
  // A bridge with TFTP off never serves these binaries, so neither their absence nor a stale bake can
  // break a boot. An unset flag counts as served, so a missed wiring fails closed instead of skipping.
  if (options.tftpEnabled === false) {
    logger.debug(
      '[PXE-01] skipping the iPXE build and bake assertions: TFTP is disabled, so this bridge serves no EFI binaries',
      { jobId: options.jobId ?? '' },
    );
    return [];
  }
  if (input.architectures.length === 0) return [];

  const findings = await evaluateIpxeBuilds(input, fileExists, readTextFile);
  if (findings.length === 0) return findings;

  const errors = findings.filter((finding) => finding.severity === 'error');
  for (const finding of findings) {
    const log = finding.severity === 'error' ? logger.error : logger.warn;
    log(`[${finding.code}] ${finding.message}`, { jobId: options.jobId ?? '' });
  }
  if (options.strict && errors.length > 0) {
    throw new Error(
      `iPXE build assertion failed (${errors.map((finding) => finding.code).join(', ')}); ` +
        'BRIDGE_IPXE_BUILDS_STRICT=true. See logged errors above.',
    );
  }
  return findings;
}
