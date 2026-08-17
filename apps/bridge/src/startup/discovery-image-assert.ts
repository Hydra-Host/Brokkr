import { join } from 'node:path';

import type { StartupLogger } from './startup-deps.types.js';

// Must mirror the literal names hard-referenced in assets/ipxe/brokkr_live.ipxe.njk.
export const REQUIRED_DISCOVERY_FILES: readonly string[] = ['vmlinuz', 'initrd.img', 'brokkr-discovery.iso'];

export interface DiscoveryImageInput {
  discoveryDir: string;
  architectures: readonly string[];
}

export interface DiscoveryImageFinding {
  arch: string;
  missing: readonly string[];
}

export type FileExists = (path: string) => Promise<boolean>;

export async function evaluateDiscoveryImages(
  input: DiscoveryImageInput,
  fileExists: FileExists,
): Promise<DiscoveryImageFinding[]> {
  const findings: DiscoveryImageFinding[] = [];
  for (const arch of input.architectures) {
    const archDir = join(input.discoveryDir, arch);
    const missing: string[] = [];
    for (const file of REQUIRED_DISCOVERY_FILES) {
      if (!(await fileExists(join(archDir, file)))) {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      findings.push({ arch, missing });
    }
  }
  return findings;
}

export async function assertDiscoveryImages(
  input: DiscoveryImageInput,
  fileExists: FileExists,
  logger: StartupLogger,
  options: { strict?: boolean; jobId?: string } = {},
): Promise<void> {
  if (input.architectures.length === 0) return;

  const findings = await evaluateDiscoveryImages(input, fileExists);
  if (findings.length === 0) return;

  for (const finding of findings) {
    logger.error(
      `[discovery-images PXE-06] Missing discovery boot ${finding.missing.length === 1 ? 'file' : 'files'} for ` +
        `arch=${finding.arch} under ${join(input.discoveryDir, finding.arch)}: ${finding.missing.join(', ')}. ` +
        'The brokkr-live chain advertises these to booting devices, so a discovery boot will 404 mid-chain. ' +
        'Required invariant: sync the discovery image set (vmlinuz, initrd.img, brokkr-discovery.iso) for ' +
        'every served arch, or drop the arch from DISCOVERY_ARCHITECTURES.',
      { jobId: options.jobId ?? '' },
    );
  }
  if (options.strict) {
    throw new Error(
      `Discovery image assertion failed for arch(es): ${findings.map((f) => f.arch).join(', ')}; ` +
        'BRIDGE_DISCOVERY_IMAGES_STRICT=true. See logged errors above.',
    );
  }
}

export interface FileInventory {
  name: string;
  present: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ArchInventory {
  arch: string;
  files: FileInventory[];
}

export type FileStat = (path: string) => Promise<{ present: boolean; sizeBytes: number; mtimeMs: number }>;

export async function inventoryDiscoveryImages(
  input: DiscoveryImageInput,
  statFile: FileStat,
): Promise<ArchInventory[]> {
  const out: ArchInventory[] = [];
  for (const arch of input.architectures) {
    const files: FileInventory[] = [];
    for (const name of REQUIRED_DISCOVERY_FILES) {
      const s = await statFile(join(input.discoveryDir, arch, name));
      files.push({ name, present: s.present, sizeBytes: s.sizeBytes, mtimeMs: s.mtimeMs });
    }
    out.push({ arch, files });
  }
  return out;
}
