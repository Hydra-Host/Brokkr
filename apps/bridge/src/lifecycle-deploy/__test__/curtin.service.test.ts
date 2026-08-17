import { describe, expect, it } from 'vitest';

import {
  computeLegacyPartitionGeometry,
  computeUefiPartitionGeometry,
  createCurtinService,
  CurtinService,
  DiskGroup,
  normalizeMdName,
  splitIntoInnerGroups,
  StorageConfig,
  StorageConfigError,
  StorageLayoutError,
} from '../curtin.service.js';

const DISK_SIZE = 480_103_981_056;

function rootGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    disks: ['sda'],
    config: 'direct',
    format: 'ext4',
    mountpoint: '/',
    disk_size: DISK_SIZE,
    ...overrides,
  };
}

describe('partition geometry', () => {
  it('computes UEFI offsets and sizes', () => {
    const g = computeUefiPartitionGeometry(DISK_SIZE);
    expect(g).toEqual({
      efi_offset: 1048576,
      efi_size: 1127219200,
      root_offset: 1128267776,
      root_size: DISK_SIZE - 1128267776 - 16385 - 5242880,
    });
  });

  it('computes Legacy BIOS offsets and sizes', () => {
    const g = computeLegacyPartitionGeometry(DISK_SIZE);
    expect(g['boot_offset']).toBe(2097152);
    expect(g['root_offset']).toBe(2149580800);
    expect(g['root_size']).toBe(DISK_SIZE - 2147483648 - 2097152 - 16385 - 5242880);
  });
});

describe('createCurtinService validation', () => {
  it('requires exactly one root group', async () => {
    await expect(createCurtinService('/target', [rootGroup({ mountpoint: '/data' })])).rejects.toThrowError(
      /Exactly one disk group must have mountpoint '\/' \(got 0\)/,
    );
  });

  it('rejects encrypting a preserved group', async () => {
    await expect(
      createCurtinService('/target', [rootGroup(), rootGroup({ mountpoint: '/data', wipe: false, encrypt: true })]),
    ).rejects.toThrowError('Cannot encrypt a preserved disk group — encryption requires wipe=True');
  });

  it('requires a target dir', async () => {
    await expect(createCurtinService('', [rootGroup()])).rejects.toThrowError(StorageConfigError);
  });
});

describe('buildLayout', () => {
  it('builds a UEFI direct layout with esp + root', async () => {
    const curtin = await createCurtinService('/target', [rootGroup()], { uefi: true, jobId: 'j' });
    await curtin.buildLayout();

    const ids = curtin.storageConfig.map((e) => e.id);
    expect(ids).toEqual(['disk-sda', 'partition-0', 'format-0', 'partition-1', 'format-1', 'mount-1', 'mount-0']);
    expect(curtin.efiDisks).toEqual(['/dev/sda']);
    expect(curtin.grubDisks).toEqual([]);
    expect(curtin.yamlContent).toContain('version: 2');
    expect(curtin.yamlContent).toContain('ptable: gpt');

    const esp = curtin.storageConfig.find((e) => e.id === 'partition-0');
    expect(esp).toMatchObject({ flag: 'boot', grub_device: true, offset: 1048576, size: 1127219200 });
    const mounts = curtin.storageConfig.filter((e) => e.type === 'mount');
    expect(mounts.map((m) => ('path' in m ? m.path : ''))).toEqual(['/', '/boot/efi']);
  });

  it('builds legacy raid1 with boot raid and md root', async () => {
    const curtin = await createCurtinService('/target', [rootGroup({ disks: ['sda', 'sdb'], config: 'raid1' })], {
      uefi: false,
      jobId: 'j',
    });
    await curtin.buildLayout();

    const raids = curtin.storageConfig.filter((e) => e.type === 'raid');
    expect(raids).toHaveLength(2);
    expect(curtin.grubDisks).toEqual(['/dev/sda', '/dev/sdb']);
    const mounts = curtin.storageConfig.filter((e) => e.type === 'mount');
    expect(mounts.map((m) => ('path' in m ? m.path : ''))).toEqual(['/', '/boot']);
  });

  it('skips md indices already in use on the spoke when naming new raid arrays', async () => {
    const config = new StorageConfig({
      targetDir: '/target',
      diskGroups: [
        new DiskGroup({
          disks: ['sda', 'sdb'],
          config: 'raid1',
          format: 'ext4',
          mountpoint: '/',
          diskSize: DISK_SIZE,
        }),
      ],
      jobId: 'j',
      uefi: false,
    });
    const curtin = new CurtinService(config, { mdNames: new Set(['md0', '/dev/md1']) });
    await curtin.buildLayout();

    const raids = curtin.storageConfig.filter((e) => e.type === 'raid');
    const names = raids.map((r) => ('name' in r ? r.name : ''));
    expect(names).toEqual(['md2', 'md3']);
  });
});

describe('splitIntoInnerGroups', () => {
  it('splits an even member list into two equal halves', () => {
    expect(splitIntoInnerGroups(['a', 'b', 'c', 'd'])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('puts the extra member in the first group for an odd count', () => {
    expect(splitIntoInnerGroups(['a', 'b', 'c', 'd', 'e'])).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
  });
});

describe('nested RAID decomposition (raid50/raid60)', () => {
  it('raid50 emits two inner raid5 sub-arrays striped by an outer raid0', async () => {
    const curtin = await createCurtinService(
      '/target',
      [
        rootGroup(),
        rootGroup({ mountpoint: '/data', config: 'raid50', disks: ['sdb', 'sdc', 'sdd', 'sde', 'sdf', 'sdg'] }),
      ],
      { uefi: true, jobId: 'j' },
    );
    await curtin.buildLayout();

    const raids = curtin.storageConfig.filter((e) => e.type === 'raid') as Array<{
      id: string;
      raidlevel: string;
      devices: string[];
    }>;
    const inner = raids.filter((r) => r.raidlevel === 'raid5');
    const outer = raids.filter((r) => r.raidlevel === 'raid0');
    expect(raids.some((r) => r.raidlevel === 'raid50')).toBe(false);
    expect(inner).toHaveLength(2);
    expect(outer).toHaveLength(1);
    expect(inner[0].devices).toHaveLength(3);
    expect(inner[1].devices).toHaveLength(3);
    expect(outer[0].devices).toEqual([inner[0].id, inner[1].id]);
  });

  it('raid60 emits two inner raid6 sub-arrays striped by an outer raid0', async () => {
    const curtin = await createCurtinService(
      '/target',
      [
        rootGroup(),
        rootGroup({
          mountpoint: '/data',
          config: 'raid60',
          disks: ['sdb', 'sdc', 'sdd', 'sde', 'sdf', 'sdg', 'sdh', 'sdi'],
        }),
      ],
      { uefi: true, jobId: 'j' },
    );
    await curtin.buildLayout();

    const raids = curtin.storageConfig.filter((e) => e.type === 'raid') as Array<{
      id: string;
      raidlevel: string;
      devices: string[];
    }>;
    expect(raids.some((r) => r.raidlevel === 'raid60')).toBe(false);
    expect(raids.filter((r) => r.raidlevel === 'raid6')).toHaveLength(2);
    expect(raids.filter((r) => r.raidlevel === 'raid0')).toHaveLength(1);
  });

  it('raid50 with a resolveDisks-shrunk subset rejects early instead of emitting an invalid inner raid5', async () => {
    const curtin = await createCurtinService(
      '/target',
      [rootGroup(), rootGroup({ mountpoint: '/data', config: 'raid50', disks: ['sdb', 'sdc', 'sdd', 'sde'] })],
      { uefi: true, jobId: 'j' },
    );
    await expect(curtin.buildLayout()).rejects.toBeInstanceOf(StorageLayoutError);
  });

  it('raid60 with a resolveDisks-shrunk subset rejects early instead of emitting an invalid inner raid6', async () => {
    const curtin = await createCurtinService(
      '/target',
      [
        rootGroup(),
        rootGroup({ mountpoint: '/data', config: 'raid60', disks: ['sdb', 'sdc', 'sdd', 'sde', 'sdf', 'sdg'] }),
      ],
      { uefi: true, jobId: 'j' },
    );
    await expect(curtin.buildLayout()).rejects.toBeInstanceOf(StorageLayoutError);
  });
});

describe('normalizeMdName', () => {
  it('normalizes bare, /dev/-prefixed, and auto-numbered md names', () => {
    expect(normalizeMdName('md0')).toBe('md0');
    expect(normalizeMdName('/dev/md1')).toBe('md1');
    expect(normalizeMdName('md127')).toBe('md127');
    expect(normalizeMdName('  md3  ')).toBe('md3');
  });

  it('returns null for non-md inputs', () => {
    expect(normalizeMdName('sda')).toBeNull();
    expect(normalizeMdName('vg0')).toBeNull();
    expect(normalizeMdName(42)).toBeNull();
    expect(normalizeMdName(null)).toBeNull();
  });

  it('skips preserved data groups and coerces restricted encrypt off', async () => {
    const curtin = await createCurtinService(
      '/target',
      [
        rootGroup(),
        rootGroup({ mountpoint: '/preserved', wipe: false, disks: ['sdc'] }),
        rootGroup({ mountpoint: '/var', encrypt: true, disks: ['sdd'] }),
      ],
      { uefi: true, jobId: 'j' },
    );
    await curtin.buildLayout();

    expect(curtin.storageConfig.some((e) => e.id === 'disk-sdc')).toBe(false);
    expect(curtin.encryptedVolumes).toEqual([]);
    expect(curtin.storageConfig.filter((e) => e.type === 'dm_crypt')).toHaveLength(0);
  });

  it('encrypts data disks with an injected luks key factory and dodges existing vg names', async () => {
    const groups = [
      rootGroup(),
      rootGroup({ mountpoint: '/data', encrypt: true, disks: ['sdd', 'sde'], config: 'lvm' }),
    ];
    const diskGroupObjects = groups.map(
      (g) =>
        new DiskGroup({
          disks: g['disks'] as string[],
          config: g['config'] as string,
          format: g['format'] as string,
          mountpoint: g['mountpoint'] as string,
          diskSize: g['disk_size'] as number,
          wipe: g['wipe'] as boolean | undefined,
          encrypt: g['encrypt'] as boolean | undefined,
        }),
    );
    const config = new StorageConfig({
      targetDir: '/target',
      diskGroups: diskGroupObjects,
      jobId: 'j',
      uefi: true,
    });
    const curtin = new CurtinService(config, { vgNames: new Set(['vg0']), luksKeyFactory: () => 'fixed-key' });
    await curtin.buildLayout();

    const crypt = curtin.storageConfig.find((e) => e.type === 'dm_crypt');
    expect(crypt).toMatchObject({ dm_name: 'crypt-0', key: 'fixed-key', preserve: false });
    const vg = curtin.storageConfig.find((e) => e.type === 'lvm_volgroup');
    expect(vg).toMatchObject({ name: 'vg1' });
    expect(curtin.encryptedVolumes).toEqual([
      {
        device: '/dev/vg1/lv-0',
        mapper: 'crypt-0',
        mountpoint: '/data',
        fs_type: 'ext4',
        label: 'data',
      },
    ]);
    expect(curtin.yamlContent).not.toContain('fixed-key\nfixed-key');
    expect(curtin.yamlContent.replace(/(key:\s+).+/g, '$1<redacted>')).not.toContain('fixed-key');
  });
});
