import { describe, expect, it } from 'vitest';
import type { StorageLayoutData } from '../../../types/discovery-processors.types';
import type { CollectorContext } from '../../collectors/collector.types';
import { StorageLayoutsComposer } from '../storage-layouts.composer';

const makeCtx = (rawBundle: Record<string, unknown>): CollectorContext => ({ rawBundle }) as CollectorContext;

describe('StorageLayoutsComposer', () => {
  const composer = new StorageLayoutsComposer();

  it('returns {} when lsblk is missing', async () => {
    const mutation = await composer.compose(makeCtx({}));
    expect(mutation).toEqual({});
  });

  it('groups nvme + hdd, picks smallest nvme for OS, hdds for data + cold', async () => {
    const lsblk = [
      { name: 'nvme0n1', size: 500_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung' },
      { name: 'nvme1n1', size: 2_000_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: 'Samsung' },
      { name: 'sda', size: 8_000_000_000_000, rota: true, serial: 'S3', wwn: '0xC', model: 'Seagate' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;

    const nvmeConfig = layouts.configs.find((c: { disk_type: string }) => c.disk_type === 'nvme');
    const hddConfig = layouts.configs.find((c: { disk_type: string }) => c.disk_type === 'hdd');
    expect(nvmeConfig).toBeDefined();
    expect(hddConfig).toBeDefined();

    expect(layouts.default.os_disks_group).toEqual({
      config: 'lvm',
      file_system: 'ext4',
      group: 'NVME_465GB',
      mountpoint: '/',
    });
    expect(layouts.default.data_disks_groups).toHaveLength(2);
    expect(layouts.default.cold_storage_disks_groups).toHaveLength(1);
  });

  it('skips virtual-serial disks', async () => {
    const lsblk = [
      { name: 'vda', size: 500_000_000_000, rota: false, serial: 'QEMU VIRTUAL DISK', wwn: null, model: null },
      { name: 'nvme0n1', size: 500_000_000_000, rota: false, serial: 'real-serial', wwn: '0xA', model: 'Samsung' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(layouts.configs).toHaveLength(1);
    expect(layouts.configs[0].disk_type).toBe('nvme');
  });

  it('drops xfs when baseboard is ASRock Rome', async () => {
    const lsblk = [{ name: 'sda', size: 1_000_000_000_000, rota: false, serial: 'x', wwn: '0xD', model: 'm' }];
    const ghw_baseboard = { baseboard: { product: 'ROMED8-2T', vendor: 'ASRockRack' } };
    const mutation = await composer.compose(makeCtx({ lsblk, ghw_baseboard }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(layouts.configs[0].file_systems).toEqual(['ext4']);
  });

  it('drops ext4 for >5TB disks on non-Rome boards', async () => {
    const lsblk = [{ name: 'sda', size: 10_000_000_000_000, rota: true, serial: 'big', wwn: '0xE', model: 'm' }];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(layouts.configs[0].file_systems).toEqual(['xfs']);
  });

  it('keeps LVM and valid RAID capabilities for a model-uniform group', async () => {
    const lsblk = Array.from({ length: 10 }, (_, i) => ({
      name: `nvme${i}n1`,
      size: 1_000_000_000_000,
      rota: false,
      serial: `S${i}`,
      wwn: `0x${i}`,
      model: 'Samsung',
    }));
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    const caps = layouts.configs[0].capabilities;
    expect(caps).toEqual(
      expect.arrayContaining(['direct', 'lvm', 'raid0', 'raid1', 'raid10', 'raid5', 'raid6', 'raid50', 'raid60']),
    );
  });

  it('offers direct and LVM for a same-size group with mixed disk models', async () => {
    const lsblk = [
      { name: 'nvme0n1', size: 2_000_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung PM9A3' },
      { name: 'nvme1n1', size: 2_000_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: 'Micron 7450' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    const caps = layouts.configs[0].capabilities;
    expect(caps).toEqual(['direct', 'lvm']);
  });

  it('assigns a mixed-model group to a default layout', async () => {
    const lsblk = [
      { name: 'nvme0n1', size: 500_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung PM9A3' },
      { name: 'sda', size: 8_000_000_000_000, rota: true, serial: 'S2', wwn: '0xB', model: 'Seagate Exos' },
      { name: 'sdb', size: 8_000_000_000_000, rota: true, serial: 'S3', wwn: '0xC', model: 'Toshiba MG' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;

    expect(layouts.default.os_disks_group?.group).toBe('NVME_465GB');
    expect(layouts.default.data_disks_groups[0]?.group).toBe('HDD_7450GB');
    expect(layouts.default.cold_storage_disks_groups[0]?.group).toBe('HDD_7450GB');
  });

  it('assigns a default OS group when all groups have mixed disk models', async () => {
    const lsblk = [
      { name: 'nvme0n1', size: 2_000_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung PM9A3' },
      { name: 'nvme1n1', size: 2_000_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: 'Micron 7450' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;

    expect(layouts.default.os_disks_group?.group).toBe('NVME_1862GB');
  });

  it('offers RAID when models differ only in case', async () => {
    const lsblk = [
      { name: 'nvme0n1', size: 2_000_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung PM9A3' },
      { name: 'nvme1n1', size: 2_000_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: 'SAMSUNG pm9a3' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(layouts.configs[0].capabilities).toContain('raid1');
  });

  it('offers RAID when models match, ignoring blank/unknown model entries', async () => {
    const lsblk = [
      { name: 'nvme0n1', size: 2_000_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung PM9A3' },
      { name: 'nvme1n1', size: 2_000_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: '' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(layouts.configs[0].capabilities).toContain('raid1');
  });

  it('emits "direct" capability for any non-empty disk group', async () => {
    const single = await composer.compose(
      makeCtx({
        lsblk: [{ name: 'nvme0n1', size: 500_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung' }],
      }),
    );
    const singleLayouts = single.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(singleLayouts.configs[0].capabilities).toContain('direct');

    const two = await composer.compose(
      makeCtx({
        lsblk: [
          { name: 'nvme0n1', size: 500_000_000_000, rota: false, serial: 'S1', wwn: '0xA', model: 'Samsung' },
          { name: 'nvme1n1', size: 500_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: 'Samsung' },
        ],
      }),
    );
    const twoLayouts = two.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    expect(twoLayouts.configs[0].capabilities).toContain('direct');
  });

  it('sorts disks within a group by name in natural order, independent of lsblk input order', async () => {
    const lsblk = [
      { name: 'nvme10n1', size: 1_000_000_000_000, rota: false, serial: 'S10', wwn: '0xA', model: 'Samsung' },
      { name: 'nvme2n1', size: 1_000_000_000_000, rota: false, serial: 'S2', wwn: '0xB', model: 'Samsung' },
      { name: 'nvme0n1', size: 1_000_000_000_000, rota: false, serial: 'S0', wwn: '0xC', model: 'Samsung' },
      { name: 'nvme1n1', size: 1_000_000_000_000, rota: false, serial: 'S1', wwn: '0xD', model: 'Samsung' },
    ];
    const mutation = await composer.compose(makeCtx({ lsblk }));
    const layouts = mutation.serverUpdate!.storageLayouts as unknown as StorageLayoutData;
    const names = layouts.configs[0].disks.map((d) => d.name);
    expect(names).toEqual(['nvme0n1', 'nvme1n1', 'nvme2n1', 'nvme10n1']);
  });
});
