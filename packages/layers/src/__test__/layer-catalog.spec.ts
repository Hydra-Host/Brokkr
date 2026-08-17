import { describe, expect, it } from 'vitest';
import { LAYER_SLUGS } from '../layer-catalog';

describe('LAYER_SLUGS', () => {
  it('exposes the five catalog groups apps and hardware rules depend on', () => {
    expect(Object.keys(LAYER_SLUGS).sort()).toEqual(['cuda', 'drivers', 'misc', 'pytorch', 'tee']);
  });

  it('keeps every slug string unique across groups', () => {
    const all = Object.values(LAYER_SLUGS).flatMap((group) => Object.values(group));
    expect(new Set(all).size).toBe(all.length);
  });

  it('preserves the slug strings that tee-requested / provision gates hard-code against', () => {
    expect(LAYER_SLUGS.tee.TEE_SETUP).toBe('tee-setup');
    expect(LAYER_SLUGS.misc.DOCKER).toBe('docker');
    expect(LAYER_SLUGS.misc.NVIDIA_CONTAINER_TOOLKIT).toBe('nvidia-container-toolkit');
    expect(LAYER_SLUGS.misc.MELLANOX_OFED).toBe('mellanox-ofed');
    expect(LAYER_SLUGS.drivers.NVIDIA_535).toBe('nvidia-driver-535');
    expect(LAYER_SLUGS.drivers.NVIDIA_580).toBe('nvidia-driver-580');
    expect(LAYER_SLUGS.drivers.NVIDIA_595).toBe('nvidia-driver-595');
  });
});
