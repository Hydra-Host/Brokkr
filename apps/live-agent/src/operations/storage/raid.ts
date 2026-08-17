// Intentionally over-cautious: the lspci filter flags disks behind even plain AHCI as maybe-RAID (skipping ATA secure erase there avoids indefinite hangs); NVMe is always force-false (own protocol, no HBA).

import { readdir, readlink } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('storage');

export interface ByPathEntry {
  name: string;
  target: string;
}

export interface RaidController {
  pci_address: string;
  description: string;
  attached_disks: string[];
}

export interface RaidTopology {
  disk_raid_status: Record<string, boolean>;
  controllers: RaidController[];
}

const BY_PATH_RE = /^pci-([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-9a-f])-.*$/i;

const BY_PATH_TARGET_RE = /^\.\.\/\.\.\/(\w+)$/;

const LSPCI_BDF_RE = /^(?:[0-9a-f]{4}:)?([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\s+(.*)$/i;
const STORAGE_CONTROLLER_RE = /sata|nvme|raid|scsi|storage/i;

export function parseRaidTopology(byPath: ByPathEntry[], lspciLines: string[]): RaidTopology {
  const diskToPci = new Map<string, string>();
  for (const entry of byPath) {
    const nameMatch = BY_PATH_RE.exec(entry.name);
    const targetMatch = BY_PATH_TARGET_RE.exec(entry.target);
    if (!nameMatch || !targetMatch) continue;
    const bdf = `${nameMatch[2]}:${nameMatch[3]}.${nameMatch[4]}`;
    const devName = targetMatch[1]!;
    if (!diskToPci.has(devName)) {
      diskToPci.set(devName, bdf);
    }
  }

  const controllerBdfs = new Set<string>();
  const controllerDescByBdf = new Map<string, string>();
  for (const line of lspciLines) {
    if (!STORAGE_CONTROLLER_RE.test(line)) continue;
    const match = LSPCI_BDF_RE.exec(line.trim());
    if (!match) continue;
    const bdf = match[1]!.toLowerCase();
    controllerBdfs.add(bdf);
    controllerDescByBdf.set(bdf, match[2]!.trim());
  }

  const disk_raid_status: Record<string, boolean> = {};
  for (const [devName, bdf] of diskToPci) {
    if (devName.startsWith('nvme')) {
      disk_raid_status[devName] = false;
      continue;
    }
    disk_raid_status[devName] = controllerBdfs.has(bdf);
  }

  const attachedByBdf = new Map<string, string[]>();
  for (const [devName, bdf] of diskToPci) {
    if (!controllerBdfs.has(bdf)) continue;
    if (devName.startsWith('nvme')) continue;
    const existing = attachedByBdf.get(bdf) ?? [];
    existing.push(devName);
    attachedByBdf.set(bdf, existing);
  }

  const controllers: RaidController[] = [...controllerBdfs].sort().map((bdf) => ({
    pci_address: bdf,
    description: controllerDescByBdf.get(bdf) ?? '',
    attached_disks: (attachedByBdf.get(bdf) ?? []).sort(),
  }));

  return { disk_raid_status, controllers };
}

async function readByPath(): Promise<ByPathEntry[]> {
  try {
    const entries = await readdir('/dev/disk/by-path/');
    const resolved: ByPathEntry[] = [];
    for (const name of entries) {
      try {
        const target = await readlink(`/dev/disk/by-path/${name}`);
        resolved.push({ name, target });
      } catch (error) {
        logger.trace('by-path readlink failed', { name, error: String(error) });
      }
    }
    return resolved;
  } catch {
    return [];
  }
}

async function readLspci(): Promise<string[]> {
  const { stdout, exit_code } = await run('lspci', ['-nn'], { timeout_ms: 15_000 });
  if (exit_code !== 0) return [];
  return stdout.split('\n').filter((line) => line.trim().length > 0);
}

export function registerRaidDetector(): void {
  registerOperation('storage.detectRaidControllers', async () => {
    const [byPath, lspciLines] = await Promise.all([readByPath(), readLspci()]);
    return parseRaidTopology(byPath, lspciLines);
  });
}
