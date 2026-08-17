import { describe, expect, it } from 'vitest';
import { resolveDiskLayouts, type LsblkDisk } from '.././resolve';

const disk = (name: string, size: number, ids: Partial<Pick<LsblkDisk, 'serial' | 'wwn'>> = {}): LsblkDisk => ({
  name,
  serial: ids.serial ?? null,
  wwn: ids.wwn ?? null,
  size,
});

describe('resolveDiskLayouts', () => {
  it('sizes a group to its smallest member, not the first resolved disk', () => {
    const allDisks = [disk('nvme0n1', 2_000_000_000_000), disk('nvme1n1', 1_000_000_000_000)];
    const layout = resolveDiskLayouts(
      [{ disks: ['nvme0n1', 'nvme1n1'], wipe: true, mountpoint: '/', fs_type: 'ext4' }],
      allDisks,
    )[0]!;
    expect(layout.disks).toEqual(['nvme0n1', 'nvme1n1']);
    expect(layout.size_bytes).toBe(1_000_000_000_000);
  });

  it('uses the min regardless of resolution order (smaller disk resolves first)', () => {
    const allDisks = [disk('sda', 500_000_000_000), disk('sdb', 750_000_000_000)];
    const layout = resolveDiskLayouts([{ disks: ['sda', 'sdb'], wipe: true }], allDisks)[0]!;
    expect(layout.size_bytes).toBe(500_000_000_000);
  });

  it('uses the single disk size for a one-disk group', () => {
    const allDisks = [disk('nvme0n1', 3_000_000_000_000)];
    const layout = resolveDiskLayouts([{ disks: ['nvme0n1'], wipe: true }], allDisks)[0]!;
    expect(layout.size_bytes).toBe(3_000_000_000_000);
  });

  it('resolves identifiers by serial and wwn, then sizes to the min', () => {
    const allDisks = [
      disk('nvme0n1', 2_000_000_000_000, { serial: 'SERIAL-A' }),
      disk('nvme1n1', 1_500_000_000_000, { wwn: 'WWN-B' }),
    ];
    const layout = resolveDiskLayouts([{ disks: ['SERIAL-A', 'WWN-B'], wipe: true }], allDisks)[0]!;
    expect(layout.disks).toEqual(['nvme0n1', 'nvme1n1']);
    expect(layout.size_bytes).toBe(1_500_000_000_000);
  });

  it('throws when no identifier resolves to a device', () => {
    expect(() => resolveDiskLayouts([{ disks: ['ghost'], wipe: true }], [disk('sda', 1)])).toThrow(
      /could not resolve disk identifiers/,
    );
  });

  it('drops layouts with no disks and echoes wipe/mountpoint/fs_type', () => {
    const allDisks = [disk('sda', 1_000), disk('sdb', 1_000)];
    const layouts = resolveDiskLayouts(
      [
        { disks: [], wipe: true },
        { disks: ['sda', 'sdb'], wipe: false, mountpoint: '/data', fs_type: 'xfs' },
      ],
      allDisks,
    );
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ wipe: false, mountpoint: '/data', fs_type: 'xfs' });
  });
});
