import type { BaseLayerSummary } from '@repo/layers';

export const mockBaseLayers: BaseLayerSummary[] = [
  { id: 'layer-ubuntu-22', slug: 'ubuntu-22', name: 'Ubuntu 22.04', family: 'base' },
  { id: 'layer-debian-12', slug: 'debian-12', name: 'Debian 12', family: 'base' },
];

export const mockComponentsByBase = {
  'ubuntu-22': [{ slug: 'nvidia-driver-580', name: 'NVIDIA Driver 580' }],
};
