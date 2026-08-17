import { describe, expect, it } from 'vitest';
import { hardwareEligibleLayerSlugs } from '../device-layer-rules.utils';

describe('hardwareEligibleLayerSlugs', () => {
  describe('guard rails', () => {
    it('returns [] when gpuModel is unrecognized', () => {
      expect(hardwareEligibleLayerSlugs('Some Random GPU', false)).toEqual([]);
    });
  });

  describe('CPU-only (gpuModel is null)', () => {
    it('returns mellanox-ofed and docker only — nvidia-container-toolkit is excluded', () => {
      expect(hardwareEligibleLayerSlugs(null, false)).toEqual(['mellanox-ofed', 'docker']);
    });

    it('does not add tee-setup even when teeEnabled=true (CPU-only)', () => {
      expect(hardwareEligibleLayerSlugs(null, true)).toEqual(['mellanox-ofed', 'docker']);
    });
  });

  describe('Blackwell B300', () => {
    it('returns 580/595 + 13.0/13.1 + pytorch-cu130 + misc', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA B300', false);
      expect(slugs).toEqual([
        'nvidia-driver-580',
        'nvidia-driver-595',
        'cuda-13.0',
        'cuda-13.1',
        'pytorch-cu130',
        'mellanox-ofed',
        'nvidia-container-toolkit',
        'docker',
      ]);
    });

    it('matches GB300 (B300 substring check)', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA GB300', false);
      expect(slugs).toContain('nvidia-driver-580');
      expect(slugs).not.toContain('nvidia-driver-535');
    });
  });

  describe('Blackwell B200', () => {
    it('returns 580/595 + 12.6/13.0/13.1 + pytorch cu126/cu130 + misc', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA B200', false);
      expect(slugs).toEqual([
        'nvidia-driver-580',
        'nvidia-driver-595',
        'cuda-12.6',
        'cuda-13.0',
        'cuda-13.1',
        'pytorch-cu126',
        'pytorch-cu130',
        'mellanox-ofed',
        'nvidia-container-toolkit',
        'docker',
      ]);
    });

    it('matches GB200 (B200 substring check)', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA GB200', false);
      expect(slugs).toContain('cuda-12.6');
      expect(slugs).not.toContain('cuda-12.2');
    });
  });

  describe('RTX PRO 6000 Blackwell', () => {
    it('returns 580/595 + 13.0/13.1 + pytorch-cu130 + misc', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA RTX PRO 6000 Blackwell Server Edition', false);
      expect(slugs).toEqual([
        'nvidia-driver-580',
        'nvidia-driver-595',
        'cuda-13.0',
        'cuda-13.1',
        'pytorch-cu130',
        'mellanox-ofed',
        'nvidia-container-toolkit',
        'docker',
      ]);
    });
  });

  describe('Universal GPUs', () => {
    it.each([
      ['NVIDIA H100'],
      ['NVIDIA H200'],
      ['NVIDIA GH200'],
      ['NVIDIA A100'],
      ['NVIDIA A30'],
      ['NVIDIA L40S'],
      ['NVIDIA RTX 6000 Ada'],
      ['NVIDIA RTX A6000'],
      ['NVIDIA GeForce RTX 3090'],
      ['NVIDIA GeForce RTX 4090'],
      ['NVIDIA GeForce RTX 5090'],
      ['NVIDIA Quadro RTX 8000'],
    ])('returns all drivers + all CUDA + all PyTorch + misc for %s', (gpu) => {
      const slugs = hardwareEligibleLayerSlugs(gpu, false);
      expect(slugs).toEqual([
        'nvidia-driver-535',
        'nvidia-driver-580',
        'nvidia-driver-595',
        'cuda-11.8',
        'cuda-12.1',
        'cuda-12.2',
        'cuda-12.4',
        'cuda-12.6',
        'cuda-12.8',
        'cuda-13.0',
        'cuda-13.1',
        'cuda-13.2',
        'pytorch-cu118',
        'pytorch-cu121',
        'pytorch-cu124',
        'pytorch-cu126',
        'pytorch-cu128',
        'pytorch-cu130',
        'mellanox-ofed',
        'nvidia-container-toolkit',
        'docker',
      ]);
    });
  });

  describe('TEE setup', () => {
    it('adds tee-setup for H100 + teeEnabled=true', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA H100', true);
      expect(slugs).toContain('tee-setup');
    });

    it('does not add tee-setup when teeEnabled=false', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA H100', false);
      expect(slugs).not.toContain('tee-setup');
    });

    it.each([['NVIDIA H200'], ['NVIDIA B200'], ['NVIDIA B300']])('adds tee-setup for plain %s', (gpu) => {
      const slugs = hardwareEligibleLayerSlugs(gpu, true);
      expect(slugs).toContain('tee-setup');
    });

    it('does not add tee-setup for Grace-Hopper GH200 (word boundary rejects gh200)', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA GH200', true);
      expect(slugs).not.toContain('tee-setup');
    });

    it('does not add tee-setup for Grace-Blackwell GB200', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA GB200', true);
      expect(slugs).not.toContain('tee-setup');
    });

    it('does not add tee-setup for Grace-Blackwell GB300', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA GB300', true);
      expect(slugs).not.toContain('tee-setup');
    });

    it('adds tee-setup for RTX PRO 6000 Blackwell Server Edition', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA RTX PRO 6000 Blackwell Server Edition', true);
      expect(slugs).toContain('tee-setup');
    });

    it('does not add tee-setup for the workstation variant of RTX PRO 6000 Blackwell', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA RTX PRO 6000 Blackwell Workstation Edition', true);
      expect(slugs).not.toContain('tee-setup');
    });

    it('does not add tee-setup for A100 (not a TEE-capable GPU)', () => {
      const slugs = hardwareEligibleLayerSlugs('NVIDIA A100', true);
      expect(slugs).not.toContain('tee-setup');
    });
  });
});
