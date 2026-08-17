import { readdir } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

interface ProbedInfo {
  detected_luks: boolean;
  luks_uuid: string;
  fs_uuid: string;
  fs_type: string;
  leaf_device: string;
}

function empty(): ProbedInfo {
  return {
    detected_luks: false,
    luks_uuid: '',
    fs_uuid: '',
    fs_type: '',
    leaf_device: '',
  };
}

async function blkidField(device: string, field: 'TYPE' | 'UUID'): Promise<string> {
  const { stdout, exit_code } = await run('blkid', ['-o', 'value', '-s', field, device], {
    timeout_ms: 10_000,
  });
  if (exit_code !== 0) return '';
  return stdout.trim();
}

async function probeLeafDevice(leafDevice: string): Promise<ProbedInfo> {
  const fsType = await blkidField(leafDevice, 'TYPE');
  const uuidVal = await blkidField(leafDevice, 'UUID');

  const info = empty();
  info.leaf_device = leafDevice;

  if (fsType === 'crypto_LUKS') {
    info.detected_luks = true;
    info.luks_uuid = uuidVal;
  } else if (fsType && uuidVal) {
    info.fs_type = fsType;
    info.fs_uuid = uuidVal;
  }
  return info;
}

async function findLeafDevice(diskName: string): Promise<string> {
  const { stdout, exit_code } = await run('lsblk', ['-lpno', 'NAME', `/dev/${diskName}`], { timeout_ms: 10_000 });
  if (exit_code !== 0) return '';
  const lines = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1]! : '';
}

async function listMdDevices(): Promise<string[]> {
  try {
    const entries = await readdir('/dev');
    return entries
      .filter((e) => /^md\d+$/.test(e))
      .map((e) => `/dev/${e}`)
      .sort();
  } catch {
    return [];
  }
}

async function scanMdArraysForLuks(claimed: Set<string>): Promise<ProbedInfo> {
  const mdDevices = await listMdDevices();
  for (const md of mdDevices) {
    if (claimed.has(md)) continue;
    const type = await blkidField(md, 'TYPE');
    if (type !== 'crypto_LUKS') continue;
    const uuid = await blkidField(md, 'UUID');
    const info = empty();
    info.detected_luks = true;
    info.luks_uuid = uuid;
    info.leaf_device = md;
    return info;
  }
  return empty();
}

interface DetectDeps {
  findLeaf: (diskName: string) => Promise<string>;
  probeLeaf: (device: string) => Promise<ProbedInfo>;
  scanMd: (claimed: Set<string>) => Promise<ProbedInfo>;
}

export async function detectPreservedDiskInfo(
  diskName: string,
  claimed: Set<string>,
  deps: DetectDeps,
): Promise<ProbedInfo> {
  const leaf = await deps.findLeaf(diskName);
  if (!leaf || leaf === `/dev/${diskName}`) {
    // A locked whole-disk LUKS container (no children) presents as the bare disk; probe it for crypto_LUKS BEFORE the md-only fallback or the volume is never recorded.
    const probed = await deps.probeLeaf(`/dev/${diskName}`);
    if (probed.detected_luks) return probed;
    return deps.scanMd(claimed);
  }
  return deps.probeLeaf(leaf);
}

export function registerPreservedDetector(): void {
  registerOperation('storage.detectPreservedDiskInfo', async ({ disk_name, claimed_md_devices }) =>
    detectPreservedDiskInfo(disk_name, new Set(claimed_md_devices ?? []), {
      findLeaf: findLeafDevice,
      probeLeaf: probeLeafDevice,
      scanMd: scanMdArraysForLuks,
    }),
  );
}
