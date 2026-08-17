import { join } from 'node:path';

import type { StartupLogger } from './startup-deps.types.js';

export const IPXE_BUILD_TARGETS = ['snponly', 'ipxe', 'snp'] as const;
export const IPXE_BUILD_EXT = 'efi';
export const IPXE_BUILD_FILENAMES = IPXE_BUILD_TARGETS.map((target) => `${target}.${IPXE_BUILD_EXT}`);

export interface IpxeBuildInput {
  finalBuildsDir: string;
  architectures: readonly string[];
}

export interface IpxeBuildFinding {
  arch: string;
  dir: string;
  acceptable: readonly string[];
}

export type FileExists = (path: string) => Promise<boolean>;

export async function evaluateIpxeBuilds(input: IpxeBuildInput, fileExists: FileExists): Promise<IpxeBuildFinding[]> {
  const findings: IpxeBuildFinding[] = [];
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
      findings.push({ arch, dir, acceptable: IPXE_BUILD_FILENAMES });
    }
  }
  return findings;
}

export async function assertIpxeBuilds(
  input: IpxeBuildInput,
  fileExists: FileExists,
  logger: StartupLogger,
  options: { strict?: boolean; jobId?: string; localSimulation?: boolean } = {},
): Promise<void> {
  if (input.architectures.length === 0) return;

  const findings = await evaluateIpxeBuilds(input, fileExists);
  if (findings.length === 0) return;

  // Local-sim boots via HTTP with TFTP disabled, so EFI binaries are absent by design — debug, never throw.
  if (options.localSimulation) {
    logger.debug(
      `[ipxe-builds PXE-01] skipping EFI-binary assertion under local simulation; ` +
        `arch(es) without a prebuilt binary: ${findings.map((f) => f.arch).join(', ')}`,
      { jobId: options.jobId ?? '' },
    );
    return;
  }

  for (const finding of findings) {
    logger.error(
      `[ipxe-builds PXE-01] No iPXE EFI binary for arch=${finding.arch} in ${finding.dir} ` +
        `(looked for any of ${finding.acceptable.join(' / ')}). The TFTP resolver maps the firmware ` +
        'bootfile (<target>-<arch>-<sha>.efi) to whichever of these exists, so a PXE boot will NAK ' +
        '(FileNotFound) before iPXE ever loads. Dockerfile.ipxe COPY contract: ' +
        `COPY --from=ipxe-${finding.arch} /export/${finding.arch}/ ${input.finalBuildsDir}/${finding.arch}/ ` +
        `(must bake any of ${finding.acceptable.join(' / ')}). Fix the COPY/ASSETS layout, or drop the arch ` +
        'from the served set.',
      { jobId: options.jobId ?? '' },
    );
  }
  if (options.strict) {
    throw new Error(
      `iPXE build assertion failed for arch(es): ${findings.map((f) => f.arch).join(', ')}; ` +
        'BRIDGE_IPXE_BUILDS_STRICT=true. See logged errors above.',
    );
  }
}
