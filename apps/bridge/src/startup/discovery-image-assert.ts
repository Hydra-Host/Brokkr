import { join } from 'node:path';

import { type BootFinding, bootCodeSpec } from '@repo/utils';
import type { DiscoveryFlavor } from '../download/discovery.config.js';

import type { StartupLogger } from './startup-deps.types.js';

// Must mirror the literal names hard-referenced in assets/ipxe/brokkr_live.ipxe.njk.
export const REQUIRED_DISCOVERY_FILES: readonly string[] = ['vmlinuz', 'initrd.img', 'brokkr-discovery.iso'];

export interface DiscoveryImageInput {
  discoveryDir: string;
  flavors: readonly DiscoveryFlavor[];
  architectures: readonly string[];
}

export type FileExists = (path: string) => Promise<boolean>;

export async function evaluateDiscoveryImages(
  input: DiscoveryImageInput,
  fileExists: FileExists,
): Promise<BootFinding[]> {
  const findings: BootFinding[] = [];
  const spec = bootCodeSpec('PXE-06');
  for (const flavor of input.flavors) {
    for (const arch of input.architectures) {
      const archDir = join(input.discoveryDir, flavor, arch);
      const missing: string[] = [];
      for (const file of REQUIRED_DISCOVERY_FILES) {
        if (!(await fileExists(join(archDir, file)))) {
          missing.push(file);
        }
      }
      if (missing.length > 0) {
        findings.push({
          code: 'PXE-06',
          severity: spec.severity,
          message:
            `${spec.title}: flavor=${flavor} arch=${arch} is missing ${missing.join(', ')} under ${archDir}, and the ` +
            `brokkr-live chain advertises those to booting devices, so a discovery boot 404s mid-chain. ${spec.remedy}`,
        });
      }
    }
  }
  return findings;
}

export async function assertDiscoveryImages(
  input: DiscoveryImageInput,
  fileExists: FileExists,
  logger: StartupLogger,
  options: { strict?: boolean; jobId?: string } = {},
): Promise<BootFinding[]> {
  if (input.architectures.length === 0) return [];

  const findings = await evaluateDiscoveryImages(input, fileExists);
  if (findings.length === 0) return findings;

  for (const finding of findings) {
    logger.error(`[${finding.code}] ${finding.message}`, { jobId: options.jobId ?? '' });
  }
  if (options.strict) {
    throw new Error(
      `Discovery image assertion failed for ${findings.length} flavor/architecture pair(s); ` +
        'BRIDGE_DISCOVERY_IMAGES_STRICT=true. See logged errors above.',
    );
  }
  return findings;
}

export interface FileInventory {
  name: string;
  present: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ArchInventory {
  flavor: DiscoveryFlavor;
  arch: string;
  files: FileInventory[];
}

export type FileStat = (path: string) => Promise<{ present: boolean; sizeBytes: number; mtimeMs: number }>;

export async function inventoryDiscoveryImages(
  input: DiscoveryImageInput,
  statFile: FileStat,
): Promise<ArchInventory[]> {
  const out: ArchInventory[] = [];
  for (const flavor of input.flavors) {
    for (const arch of input.architectures) {
      const files: FileInventory[] = [];
      for (const name of REQUIRED_DISCOVERY_FILES) {
        const s = await statFile(join(input.discoveryDir, flavor, arch, name));
        files.push({ name, present: s.present, sizeBytes: s.sizeBytes, mtimeMs: s.mtimeMs });
      }
      out.push({ flavor, arch, files });
    }
  }
  return out;
}
