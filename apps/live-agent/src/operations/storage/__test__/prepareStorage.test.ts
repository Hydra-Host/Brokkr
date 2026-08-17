import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));

import { clearOperationsForTests, getHandler, registerOperation } from '../../../dispatch/registry';
import { registerPrepareStorage } from '../prepareStorage';

const ctx = {
  work_id: 'test',
  job_id: 'test',
  signal: new AbortController().signal,
  resultDelivered: Promise.resolve(),
  reportProgress: () => {},
  emit: () => Promise.resolve(),
};

interface ProbeResponse {
  detected_luks: boolean;
  luks_uuid: string;
  fs_uuid: string;
  fs_type: string;
  leaf_device: string;
}

function wireSubOps(opts: {
  resolvedLayouts: Array<{ disks: string[]; size_bytes: number; wipe: boolean; mountpoint?: string; fs_type?: string }>;
  probes: ProbeResponse[];
}) {
  let probeIdx = 0;
  const responses: Array<[string, unknown]> = [
    ['system.getArchitecture', { arch: 'x86_64', raw: 'x86_64' }],
    ['storage.unmountDisks', { unmounted_paths: [] }],
    ['storage.resolveDisks', { layouts: opts.resolvedLayouts }],
    ['storage.detectUefiMode', { uefi_mode: true }],
    ['storage.applyStorageLayout', { fstab_content: 'UUID=root / ext4 defaults 0 1\n', success: true }],
  ];
  for (const [name, response] of responses) {
    registerOperation(name as never, (async () => response) as never);
  }
  registerOperation(
    'storage.detectPreservedDiskInfo' as never,
    (async () => {
      const probe = opts.probes[probeIdx++];
      if (!probe) throw new Error('detectPreservedDiskInfo called more times than probes provided');
      return probe;
    }) as never,
  );
}

beforeEach(() => {
  clearOperationsForTests();
});

async function run(input: unknown): Promise<{
  crypttab: string;
  fstab: string;
  preserved_encrypted_volumes: Array<{
    mapper: string;
    fs_type: string;
    mountpoint: string;
    device: string;
    luks_uuid: string;
  }>;
}> {
  registerPrepareStorage();
  const entry = getHandler('storage.prepareStorage');
  if (!entry) throw new Error('prepareStorage not registered');
  return entry.handler(input, ctx as never) as never;
}

describe('storage.prepareStorage — preserved dm-crypt mapper namespacing', () => {
  it('names preserved LUKS mappers pcrypt-N so they never collide with curtin crypt-N on a mixed layout', async () => {
    wireSubOps({
      resolvedLayouts: [
        { disks: ['nvme0n1'], size_bytes: 1_000, wipe: true, mountpoint: '/', fs_type: 'ext4' },
        { disks: ['sdb'], size_bytes: 2_000, wipe: false, mountpoint: '/keep', fs_type: 'xfs' },
      ],
      probes: [
        {
          detected_luks: true,
          luks_uuid: '11111111-1111-1111-1111-111111111111',
          fs_uuid: '',
          fs_type: '',
          leaf_device: '/dev/sdb1',
        },
      ],
    });

    const out = await run({
      disk_layouts: [
        { disks: ['nvme0n1'], wipe: true, mountpoint: '/', fs_type: 'ext4' },
        { disks: ['sdb'], wipe: false, mountpoint: '/keep', fs_type: 'xfs' },
      ],
      target_path: '/target',
      curtin_yaml: 'version: 2',
    });

    expect(out.preserved_encrypted_volumes).toHaveLength(1);
    const mapper = out.preserved_encrypted_volumes[0]!.mapper;
    expect(mapper).toBe('pcrypt-0');
    expect(mapper).not.toMatch(/^crypt-\d+$/);
    expect(out.preserved_encrypted_volumes[0]!.fs_type).toBe('xfs');
    expect(out.crypttab).toContain('pcrypt-0 UUID=11111111-1111-1111-1111-111111111111');
    expect(out.fstab).toContain('-pcrypt-0');
  });

  it('assigns distinct pcrypt-N indices when several preserved LUKS disks are present (no mapper reuse)', async () => {
    wireSubOps({
      resolvedLayouts: [
        { disks: ['sdb'], size_bytes: 2_000, wipe: false, mountpoint: '/keep1', fs_type: 'ext4' },
        { disks: ['sdc'], size_bytes: 2_000, wipe: false, mountpoint: '/keep2', fs_type: 'ext4' },
      ],
      probes: [
        {
          detected_luks: true,
          luks_uuid: 'aaaaaaaa-0000-0000-0000-000000000000',
          fs_uuid: '',
          fs_type: '',
          leaf_device: '/dev/sdb1',
        },
        {
          detected_luks: true,
          luks_uuid: 'bbbbbbbb-0000-0000-0000-000000000000',
          fs_uuid: '',
          fs_type: '',
          leaf_device: '/dev/sdc1',
        },
      ],
    });

    const out = await run({
      disk_layouts: [
        { disks: ['sdb'], wipe: false, mountpoint: '/keep1', fs_type: 'ext4' },
        { disks: ['sdc'], wipe: false, mountpoint: '/keep2', fs_type: 'ext4' },
      ],
      target_path: '/target',
      curtin_yaml: 'version: 2',
    });

    const mappers = out.preserved_encrypted_volumes.map((v) => v.mapper);
    expect(mappers).toEqual(['pcrypt-0', 'pcrypt-1']);
    expect(new Set(mappers).size).toBe(mappers.length);
    expect(out.preserved_encrypted_volumes.map((v) => v.luks_uuid)).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000000',
      'bbbbbbbb-0000-0000-0000-000000000000',
    ]);
  });
});
