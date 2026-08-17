import { describe, expect, it, vi } from 'vitest';
import { detectPreservedDiskInfo } from '../preserved';

const luksInfo = (device: string) => ({
  detected_luks: true,
  luks_uuid: 'uuid-123',
  fs_uuid: '',
  fs_type: '',
  leaf_device: device,
});

const emptyInfo = () => ({ detected_luks: false, luks_uuid: '', fs_uuid: '', fs_type: '', leaf_device: '' });

describe('detectPreservedDiskInfo', () => {
  it('probes a child leaf device when lsblk shows children', async () => {
    const probeLeaf = vi.fn().mockResolvedValue(luksInfo('/dev/sda1'));
    const scanMd = vi.fn();
    const info = await detectPreservedDiskInfo('sda', new Set(), {
      findLeaf: async () => '/dev/sda1',
      probeLeaf,
      scanMd,
    });
    expect(probeLeaf).toHaveBeenCalledWith('/dev/sda1');
    expect(scanMd).not.toHaveBeenCalled();
    expect(info.detected_luks).toBe(true);
  });

  it('probes the bare disk for crypto_LUKS before the md-only fallback (locked whole-disk LUKS)', async () => {
    const probeLeaf = vi.fn().mockResolvedValue(luksInfo('/dev/sda'));
    const scanMd = vi.fn();
    const info = await detectPreservedDiskInfo('sda', new Set(), {
      findLeaf: async () => '/dev/sda',
      probeLeaf,
      scanMd,
    });
    expect(probeLeaf).toHaveBeenCalledWith('/dev/sda');
    expect(scanMd).not.toHaveBeenCalled();
    expect(info).toMatchObject({ detected_luks: true, luks_uuid: 'uuid-123' });
  });

  it('falls back to scanning md arrays only when the bare disk is not LUKS', async () => {
    const probeLeaf = vi.fn().mockResolvedValue(emptyInfo());
    const scanMd = vi.fn().mockResolvedValue(luksInfo('/dev/md0'));
    const info = await detectPreservedDiskInfo('sda', new Set(), {
      findLeaf: async () => '/dev/sda',
      probeLeaf,
      scanMd,
    });
    expect(probeLeaf).toHaveBeenCalledWith('/dev/sda');
    expect(scanMd).toHaveBeenCalledOnce();
    expect(info.leaf_device).toBe('/dev/md0');
  });
});
