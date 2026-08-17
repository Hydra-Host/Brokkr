import { SUPPORTED_DISK_FORMATS } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { coerceDefaultDiskLayouts, toDiskFormat } from '../schemas.js';

describe('toDiskFormat (read/display path)', () => {
  it('passes through supported formats', () => {
    expect(toDiskFormat('ext4')).toBe('ext4');
    expect(toDiskFormat('xfs')).toBe('xfs');
  });

  it('falls back to the first supported format for the empty default the API emits', () => {
    expect(toDiskFormat('')).toBe(SUPPORTED_DISK_FORMATS[0]);
  });

  it('falls back for unrecognized formats instead of throwing', () => {
    expect(() => toDiskFormat('btrfs')).not.toThrow();
    expect(toDiskFormat('btrfs')).toBe(SUPPORTED_DISK_FORMATS[0]);
  });
});

describe('coerceDefaultDiskLayouts', () => {
  it('coerces empty/unknown formats and preserves other fields', () => {
    const out = coerceDefaultDiskLayouts([
      { config: 'os', format: '', mountpoint: '/', diskType: 'nvme', disks: ['nvme0n1'] },
    ]);
    expect(out[0]).toEqual({
      config: 'os',
      format: SUPPORTED_DISK_FORMATS[0],
      mountpoint: '/',
      diskType: 'nvme',
      disks: ['nvme0n1'],
      wipe: true,
    });
  });
});
