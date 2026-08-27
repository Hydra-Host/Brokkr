import { describe, expect, it, vi } from 'vitest';
import {
  clearSignaturesExcludingSharedStacks,
  diskNameFromPartition,
  findPreservedRaidMembers,
  findPreservedVgPvs,
  holderSortKey,
  mdPartitionParent,
  parseMdadmMembers,
} from '../teardown-holders';

describe('mdPartitionParent', () => {
  it('resolves an md partition to its parent array', () => {
    expect(mdPartitionParent('/dev/md0p1')).toBe('/dev/md0');
    expect(mdPartitionParent('/dev/md127p3')).toBe('/dev/md127');
  });

  it('returns empty for a whole md array (not a partition)', () => {
    expect(mdPartitionParent('/dev/md0')).toBe('');
    expect(mdPartitionParent('/dev/md127')).toBe('');
  });

  it('returns empty for non-md devices', () => {
    expect(mdPartitionParent('/dev/sda1')).toBe('');
    expect(mdPartitionParent('/dev/mapper/vg-lv')).toBe('');
  });
});

describe('diskNameFromPartition', () => {
  it('strips a trailing partition number for SATA-style names', () => {
    expect(diskNameFromPartition('sda1')).toBe('sda');
    expect(diskNameFromPartition('sda')).toBe('sda');
    expect(diskNameFromPartition('sdb12')).toBe('sdb');
  });

  it('keeps the nvme namespace, strips the partition suffix', () => {
    expect(diskNameFromPartition('nvme0n1p1')).toBe('nvme0n1');
    expect(diskNameFromPartition('nvme0n1')).toBe('nvme0n1');
    expect(diskNameFromPartition('nvme1n2p42')).toBe('nvme1n2');
  });

  it('strips a leading /dev/ prefix', () => {
    expect(diskNameFromPartition('/dev/sda1')).toBe('sda');
    expect(diskNameFromPartition('/dev/nvme0n1p3')).toBe('nvme0n1');
  });
});

describe('parseMdadmMembers', () => {
  it('extracts /dev/ members, excluding the array itself', () => {
    const output = `
/dev/md0:
           Version : 1.2
     Creation Time : Mon Apr 21 10:22:33 2026
        Raid Level : raid0
        Array Size : 3999999999

    Number   Major   Minor   RaidDevice State
       0       8       17        0      active sync   /dev/sdb1
       1       8       33        1      active sync   /dev/sdc1
`;
    const members = parseMdadmMembers(output, '/dev/md0');
    expect(members).toEqual(['/dev/sdb1', '/dev/sdc1']);
  });

  it('returns empty when there are no /dev/ lines', () => {
    expect(parseMdadmMembers('no devices here\n', '/dev/md0')).toEqual([]);
  });

  it('ignores lines containing the array path itself', () => {
    const output = `
/dev/md0 is assembled.
       0       8       17        0      active sync   /dev/sda1
`;
    expect(parseMdadmMembers(output, '/dev/md0')).toEqual(['/dev/sda1']);
  });

  it('handles NVMe member devices', () => {
    const output = `
/dev/md127:
    Number   Major   Minor   RaidDevice State
       0     259        2        0      active sync   /dev/nvme0n1p1
       1     259        5        1      active sync   /dev/nvme1n1p1
`;
    expect(parseMdadmMembers(output, '/dev/md127')).toEqual(['/dev/nvme0n1p1', '/dev/nvme1n1p1']);
  });
});

describe('findPreservedRaidMembers', () => {
  it('returns empty when no member touches a preserved disk', () => {
    const members = ['/dev/sda1', '/dev/sdb1'];
    const preserve = new Set<string>(['sdc']);
    expect(findPreservedRaidMembers(members, preserve)).toEqual([]);
  });

  it('returns the preserved member when one member is preserved', () => {
    const members = ['/dev/sda1', '/dev/sdb1'];
    const preserve = new Set<string>(['sdb']);
    expect(findPreservedRaidMembers(members, preserve)).toEqual(['/dev/sdb1']);
  });

  it('returns multiple preserved members when several are preserved', () => {
    const members = ['/dev/sda1', '/dev/sdb1', '/dev/sdc1'];
    const preserve = new Set<string>(['sdb', 'sdc']);
    expect(findPreservedRaidMembers(members, preserve)).toEqual(['/dev/sdb1', '/dev/sdc1']);
  });

  it('correctly maps NVMe partition paths to their namespace-level disk name', () => {
    const members = ['/dev/nvme0n1p1', '/dev/nvme1n1p1'];
    const preserve = new Set<string>(['nvme0n1']);
    expect(findPreservedRaidMembers(members, preserve)).toEqual(['/dev/nvme0n1p1']);
  });

  it('handles the preserve set keyed by disk name (no /dev/ prefix)', () => {
    const members = ['/dev/sda1'];
    expect(findPreservedRaidMembers(members, new Set(['sda']))).toEqual(['/dev/sda1']);
    expect(findPreservedRaidMembers(members, new Set(['/dev/sda']))).toEqual([]);
  });

  it('is empty when the array has no members (degraded array)', () => {
    expect(findPreservedRaidMembers([], new Set(['sda']))).toEqual([]);
  });
});

describe('findPreservedVgPvs', () => {
  it('returns empty when no PV touches a preserved disk', () => {
    const pvs = ['/dev/sda1', '/dev/sdb1'];
    expect(findPreservedVgPvs(pvs, new Set(['sdc']))).toEqual([]);
  });

  it('returns the preserved PV when a VG spans a preserved + a wiped disk', () => {
    const pvs = ['/dev/sda1', '/dev/sdb1'];
    expect(findPreservedVgPvs(pvs, new Set(['sdb']))).toEqual(['/dev/sdb1']);
  });

  it('returns multiple preserved PVs when several PVs are preserved', () => {
    const pvs = ['/dev/sda1', '/dev/sdb1', '/dev/sdc1'];
    expect(findPreservedVgPvs(pvs, new Set(['sdb', 'sdc']))).toEqual(['/dev/sdb1', '/dev/sdc1']);
  });

  it('maps NVMe PV partitions to their namespace-level disk name', () => {
    const pvs = ['/dev/nvme0n1p1', '/dev/nvme1n1p1'];
    expect(findPreservedVgPvs(pvs, new Set(['nvme0n1']))).toEqual(['/dev/nvme0n1p1']);
  });

  it('keys the preserve set by base disk name (no /dev/ prefix)', () => {
    const pvs = ['/dev/sda1'];
    expect(findPreservedVgPvs(pvs, new Set(['sda']))).toEqual(['/dev/sda1']);
    expect(findPreservedVgPvs(pvs, new Set(['/dev/sda']))).toEqual([]);
  });

  it('is empty for a VG with no PVs', () => {
    expect(findPreservedVgPvs([], new Set(['sda']))).toEqual([]);
  });
});

describe('clearSignaturesExcludingSharedStacks', () => {
  const emptySummary = () => ({
    crypt_closed: [],
    lvm_removed: [],
    vg_removed: [],
    raid_stopped: [],
    swap_deactivated: [],
    signatures_cleared: [],
    skipped_preserved: [],
  });
  const noopLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  it('clears signatures on a plain wipe-target but skips a shared-stack sibling', async () => {
    const cleared: string[] = [];
    const clearer = vi.fn(async (disk: string) => {
      cleared.push(disk);
    });
    await clearSignaturesExcludingSharedStacks(['sda', 'sdb'], new Set(['sdb']), emptySummary(), noopLog, clearer);
    expect(cleared).toEqual(['sda']);
    expect(clearer).not.toHaveBeenCalledWith('sdb', expect.anything(), expect.anything());
  });

  it('clears every disk when no sibling shares a preserved stack', async () => {
    const cleared: string[] = [];
    const clearer = vi.fn(async (disk: string) => {
      cleared.push(disk);
    });
    await clearSignaturesExcludingSharedStacks(['sda', 'sdb'], new Set(), emptySummary(), noopLog, clearer);
    expect(cleared).toEqual(['sda', 'sdb']);
  });
});

describe('holderSortKey', () => {
  it('sorts deeper depth before shallower depth', () => {
    const deep = { depth: 5, layer_type: 'crypt' as const };
    const shallow = { depth: 2, layer_type: 'crypt' as const };
    const [sortedDeep, sortedShallow] = [deep, shallow].sort((a, b) => {
      const [da, la] = holderSortKey(a);
      const [db, lb] = holderSortKey(b);
      return da - db || la - lb;
    });
    expect(sortedDeep).toBe(deep);
    expect(sortedShallow).toBe(shallow);
  });

  it('applies layer priority at equal depth: crypt → LVM → RAID → partition → disk', () => {
    const nodes = [
      { depth: 3, layer_type: 'disk' as const },
      { depth: 3, layer_type: 'crypt' as const },
      { depth: 3, layer_type: 'partition' as const },
      { depth: 3, layer_type: 'lvm' as const },
      { depth: 3, layer_type: 'raid' as const },
    ];
    const sorted = [...nodes].sort((a, b) => {
      const [da, la] = holderSortKey(a);
      const [db, lb] = holderSortKey(b);
      return da - db || la - lb;
    });
    expect(sorted.map((n) => n.layer_type)).toEqual(['crypt', 'lvm', 'raid', 'partition', 'disk']);
  });

  it('depth always outranks layer priority', () => {
    const deepDisk = { depth: 5, layer_type: 'disk' as const };
    const shallowCrypt = { depth: 2, layer_type: 'crypt' as const };
    const sorted = [shallowCrypt, deepDisk].sort((a, b) => {
      const [da, la] = holderSortKey(a);
      const [db, lb] = holderSortKey(b);
      return da - db || la - lb;
    });
    expect(sorted[0]).toBe(deepDisk);
  });
});
