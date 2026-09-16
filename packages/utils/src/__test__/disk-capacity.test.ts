import {
  DATA_PARTITION_OVERHEAD_BYTES,
  LEGACY_ROOT_OFFSET,
  ROOT_PARTITION_OVERHEAD_BYTES,
  UEFI_ROOT_OFFSET,
  perDiskBytesForUsable,
  raidDataMultiplier,
  raidUsableCapacityBytes,
} from '../disk-capacity';

describe('raidDataMultiplier', () => {
  it('returns 1 for single-disk and mirrored configs', () => {
    expect(raidDataMultiplier('direct', 1)).toBe(1);
    expect(raidDataMultiplier('raid1', 2)).toBe(1);
    expect(raidDataMultiplier('raid1', 4)).toBe(1);
  });

  it('uses every disk for pooled and striped configs', () => {
    expect(raidDataMultiplier('lvm', 3)).toBe(3);
    expect(raidDataMultiplier('raid0', 4)).toBe(4);
  });

  it('subtracts parity disks', () => {
    expect(raidDataMultiplier('raid5', 4)).toBe(3);
    expect(raidDataMultiplier('raid6', 6)).toBe(4);
    expect(raidDataMultiplier('raid50', 6)).toBe(4);
    expect(raidDataMultiplier('raid60', 8)).toBe(4);
  });

  it('halves the disk count for raid10', () => {
    expect(raidDataMultiplier('raid10', 4)).toBe(2);
    expect(raidDataMultiplier('raid10', 5)).toBe(2);
  });

  it('returns 1 for unknown configs', () => {
    expect(raidDataMultiplier('jbod', 5)).toBe(1);
    expect(raidDataMultiplier('', 5)).toBe(1);
  });

  it('clamps to a minimum of 1', () => {
    expect(raidDataMultiplier('raid5', 1)).toBe(1);
    expect(raidDataMultiplier('raid6', 2)).toBe(1);
    expect(raidDataMultiplier('raid60', 3)).toBe(1);
    expect(raidDataMultiplier('raid10', 1)).toBe(1);
    expect(raidDataMultiplier('raid0', 0)).toBe(1);
  });
});

describe('raidUsableCapacityBytes', () => {
  it('multiplies per-disk bytes by the data stripe count', () => {
    expect(raidUsableCapacityBytes('raid5', 4, 1000n)).toBe(3000n);
    expect(raidUsableCapacityBytes('raid1', 2, 1000n)).toBe(1000n);
    expect(raidUsableCapacityBytes('raid0', 3, 1000n)).toBe(3000n);
    expect(raidUsableCapacityBytes('raid10', 6, 1000n)).toBe(3000n);
  });
});

describe('perDiskBytesForUsable', () => {
  it('divides with ceiling so the array never undershoots', () => {
    expect(perDiskBytesForUsable('raid5', 3, 10n)).toBe(5n);
    expect(perDiskBytesForUsable('raid0', 3, 10n)).toBe(4n);
    expect(perDiskBytesForUsable('raid0', 3, 9n)).toBe(3n);
    expect(perDiskBytesForUsable('direct', 1, 7n)).toBe(7n);
  });

  it('inverts raidUsableCapacityBytes to at least the requested size', () => {
    const cases: Array<[string, number]> = [
      ['direct', 1],
      ['raid1', 2],
      ['lvm', 3],
      ['raid0', 4],
      ['raid5', 4],
      ['raid6', 6],
      ['raid10', 6],
      ['raid50', 6],
      ['raid60', 8],
    ];
    for (const [config, diskCount] of cases) {
      const perDisk = perDiskBytesForUsable(config, diskCount, 1_000_003n);
      expect(raidUsableCapacityBytes(config, diskCount, perDisk)).toBeGreaterThanOrEqual(1_000_003n);
      expect(raidUsableCapacityBytes(config, diskCount, perDisk - 1n)).toBeLessThan(1_000_003n);
    }
  });
});

describe('partition geometry constants', () => {
  it('pins the derived values', () => {
    expect(UEFI_ROOT_OFFSET).toBe(1128267776);
    expect(LEGACY_ROOT_OFFSET).toBe(2149580800);
    expect(ROOT_PARTITION_OVERHEAD_BYTES).toBe(2154840065n);
    expect(DATA_PARTITION_OVERHEAD_BYTES).toBe(6307841n);
  });
});
