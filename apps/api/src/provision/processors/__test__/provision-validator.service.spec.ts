import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import type { DiskLayout, ProvisionRequest } from '@repo/api-client';
import { StorageDriveType, type LayerKind, type StorageDrive } from '@repo/database';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { flattenCustomizations, ProvisionValidatorService } from '../provision-validator.service';

const LAYER_BUILD_ID = 'test-layer-build-id';

const ALL_LAYERS: { slug: string; kind: LayerKind }[] = [
  { slug: 'ubuntu-22.04', kind: 'BASE' },
  { slug: 'ubuntu-24.04', kind: 'BASE' },
  { slug: 'debian-bookworm-hpc', kind: 'LEGACY' },
  { slug: 'nvidia-driver-535', kind: 'COMPONENT' },
  { slug: 'nvidia-driver-580', kind: 'COMPONENT' },
  { slug: 'nvidia-driver-595', kind: 'COMPONENT' },
  { slug: 'cuda-12.2', kind: 'COMPONENT' },
  { slug: 'cuda-12.6', kind: 'COMPONENT' },
  { slug: 'cuda-13.0', kind: 'COMPONENT' },
  { slug: 'cuda-13.1', kind: 'COMPONENT' },
  { slug: 'pytorch-cu118', kind: 'COMPONENT' },
  { slug: 'pytorch-cu126', kind: 'COMPONENT' },
  { slug: 'pytorch-cu130', kind: 'COMPONENT' },
  { slug: 'mellanox-ofed', kind: 'COMPONENT' },
  { slug: 'nvidia-container-toolkit', kind: 'COMPONENT' },
  { slug: 'docker', kind: 'COMPONENT' },
];

const CUDA_DRIVER_RELATIONS: Record<string, string[]> = {
  'cuda-12.2': ['nvidia-driver-535', 'nvidia-driver-580', 'nvidia-driver-595'],
  'cuda-12.6': ['nvidia-driver-580', 'nvidia-driver-595'],
  'cuda-13.0': ['nvidia-driver-580', 'nvidia-driver-595'],
  'cuda-13.1': ['nvidia-driver-595'],
};

const PYTORCH_CUDA_RELATIONS: Record<string, string[]> = {
  'pytorch-cu118': ['cuda-11.8'],
  'pytorch-cu126': ['cuda-12.6'],
  'pytorch-cu130': ['cuda-13.0', 'cuda-13.1', 'cuda-13.2'],
};

describe('flattenCustomizations', () => {
  it('should return null for null input', () => {
    expect(flattenCustomizations(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(flattenCustomizations(undefined)).toBeNull();
  });

  it('should return null for an empty object', () => {
    expect(flattenCustomizations({})).toBeNull();
  });

  it('should flatten single-select string values', () => {
    const result = flattenCustomizations({
      gpuDriver: 'nvidia-driver-580',
      gpuFramework: 'cuda-12.6',
    });
    expect(result).toEqual(['nvidia-driver-580', 'cuda-12.6']);
  });

  it('should flatten multi-select array values', () => {
    const result = flattenCustomizations({
      miscSoftware: ['docker', 'ollama'],
    });
    expect(result).toEqual(['docker', 'ollama']);
  });

  it('should flatten mixed single-select and multi-select values', () => {
    const result = flattenCustomizations({
      gpuDriver: 'nvidia-driver-580',
      gpuFramework: 'cuda-13-1',
      miscSoftware: ['docker', 'ollama'],
    });
    expect(result).toEqual(['nvidia-driver-580', 'cuda-13-1', 'docker', 'ollama']);
  });

  it('should produce the same result regardless of key order', () => {
    const a = flattenCustomizations({
      gpuDriver: 'nvidia-driver-580',
      miscSoftware: ['docker'],
    });
    const b = flattenCustomizations({
      miscSoftware: ['docker'],
      gpuDriver: 'nvidia-driver-580',
    });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.sort()).toEqual(b!.sort());
  });
});

const JAMMY_BASE_SAMPLE = { osDistro: 'ubuntu', osCodename: 'jammy' };

describe('ProvisionValidatorService', () => {
  let service: ProvisionValidatorService;
  let mockLayerFindMany: Mock;
  let mockLayerFindUnique: Mock;
  let mockArtifactFindMany: Mock;

  beforeEach(async () => {
    mockLayerFindMany = vi.fn().mockResolvedValue(ALL_LAYERS);
    mockLayerFindUnique = vi.fn().mockImplementation(async ({ where }: { where: { slug: string } }) => {
      const layer = ALL_LAYERS.find((l) => l.slug === where.slug);
      if (!layer || layer.kind !== 'BASE') return null;
      return { artifacts: [JAMMY_BASE_SAMPLE] };
    });
    mockArtifactFindMany = vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      const layerFilter = (where.layer ?? {}) as Record<string, string>;
      const selectorSlug = layerFilter.slug ?? '';
      const related = selectorSlug.startsWith('pytorch-')
        ? (PYTORCH_CUDA_RELATIONS[selectorSlug] ?? [])
        : (CUDA_DRIVER_RELATIONS[selectorSlug] ?? []);
      return [{ relations: related.map((slug) => ({ relatedLayer: { slug } })) }];
    });

    ActiveRecordRegistry.configureForTest({
      layer: { findMany: mockLayerFindMany, findUnique: mockLayerFindUnique },
      layerArtifact: { findMany: mockArtifactFindMany },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProvisionValidatorService],
    }).compile();

    service = module.get<ProvisionValidatorService>(ProvisionValidatorService);
  });

  describe('validateCustomizations', () => {
    describe('no-op cases', () => {
      it('passes for null', async () => {
        await expect(service.validateCustomizations(null, null, false)).resolves.toBeUndefined();
      });

      it('passes for undefined', async () => {
        await expect(service.validateCustomizations(undefined, null, false)).resolves.toBeUndefined();
      });

      it('passes for an empty array', async () => {
        await expect(service.validateCustomizations([], null, false)).resolves.toBeUndefined();
      });
    });

    describe('valid inputs (universal GPU)', () => {
      it('accepts a single driver layer', async () => {
        await expect(
          service.validateCustomizations(['nvidia-driver-580'], 'NVIDIA H100 SXM5 80GB', false),
        ).resolves.toBeUndefined();
      });

      it('accepts a CUDA layer with a compatible driver on a BASE OS', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-580', 'cuda-12.6'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).resolves.toBeUndefined();
      });

      it('accepts cuda-13.1 with the only compatible driver (595) on a BASE OS', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-595', 'cuda-13.1'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).resolves.toBeUndefined();
      });
    });

    describe('unknown slug', () => {
      it('throws for an unrecognised layer slug', async () => {
        await expect(service.validateCustomizations(['nvidia-driver-999'], null, false)).rejects.toThrow(
          new BadRequestException('Unknown OS Customization: "nvidia-driver-999"'),
        );
      });

      it('throws for a partially valid list containing an unknown slug', async () => {
        await expect(
          service.validateCustomizations(['nvidia-driver-580', 'cuda-99.9'], 'NVIDIA H100 SXM5 80GB', false),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('LEGACY OSes reject customizations', () => {
      it('throws when operatingSystem kind is LEGACY', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-580'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'debian-bookworm-hpc',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).rejects.toThrow(/legacy operating systems/);
      });
    });

    describe('cardinality', () => {
      it('throws when two driver layers are specified', async () => {
        await expect(
          service.validateCustomizations(['nvidia-driver-535', 'nvidia-driver-580'], 'NVIDIA H100 SXM5 80GB', false),
        ).rejects.toThrow(/Only one nvidia driver layer/);
      });

      it('throws when two CUDA layers are specified', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-580', 'cuda-12.2', 'cuda-12.6'],
            'NVIDIA H100 SXM5 80GB',
            false,
          ),
        ).rejects.toThrow(/Only one CUDA layer/);
      });

      it('throws when CUDA is specified without a driver', async () => {
        await expect(service.validateCustomizations(['cuda-12.6'], 'NVIDIA H100 SXM5 80GB', false)).rejects.toThrow(
          /A CUDA layer requires a compatible nvidia driver layer/,
        );
      });

      it('throws when nvidia-container-toolkit is specified without a driver', async () => {
        await expect(
          service.validateCustomizations(['nvidia-container-toolkit'], 'NVIDIA H100 SXM5 80GB', false),
        ).rejects.toThrow(/nvidia-container-toolkit requires a compatible nvidia driver/);
      });

      it('throws when two PyTorch layers are specified', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-595', 'cuda-13.0', 'pytorch-cu126', 'pytorch-cu130'],
            'NVIDIA H100 SXM5 80GB',
            false,
          ),
        ).rejects.toThrow(/Only one PyTorch layer/);
      });

      it('accepts PyTorch without a CUDA layer (PyTorch ships its own CUDA runtime)', async () => {
        await expect(
          service.validateCustomizations(['nvidia-driver-595', 'pytorch-cu130'], 'NVIDIA H100 SXM5 80GB', false),
        ).resolves.toBeUndefined();
      });
    });

    describe('CUDA + driver incompatibility (per-artifact REQUIRES)', () => {
      it('throws when driver is older than cuda-13.1 minimum (595)', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-580', 'cuda-13.1'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).rejects.toThrow(/Driver "nvidia-driver-580" is not compatible with "cuda-13.1"/);
      });

      it('throws for cuda-13.0 with a driver below 580', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-535', 'cuda-13.0'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('PyTorch + CUDA incompatibility (per-artifact REQUIRES)', () => {
      it('accepts pytorch-cu130 with cuda-13.0 (in pytorch-cu130 REQUIRES set)', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-595', 'cuda-13.0', 'pytorch-cu130'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).resolves.toBeUndefined();
      });

      it('throws when CUDA is older than the chosen PyTorch wheel supports', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-595', 'cuda-13.0', 'pytorch-cu118'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).rejects.toThrow(/CUDA "cuda-13\.0" is not compatible with "pytorch-cu118"/);
      });

      it('throws when CUDA major mismatches the PyTorch wheel', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-580', 'cuda-12.6', 'pytorch-cu130'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            undefined,
            LAYER_BUILD_ID,
          ),
        ).rejects.toThrow(/Compatible CUDA versions: cuda-13\.0, cuda-13\.1, cuda-13\.2/);
      });

      it('skips the per-artifact check when osKind is not BASE', async () => {
        await expect(
          service.validateCustomizations(
            ['nvidia-driver-595', 'cuda-13.0', 'pytorch-cu118'],
            'NVIDIA H100 SXM5 80GB',
            false,
          ),
        ).resolves.toBeUndefined();
      });
    });

    describe('hardware-eligibility (gpuModel + teeEnabled)', () => {
      it('rejects driver-535 on B300 (not in B300 eligible set)', async () => {
        await expect(service.validateCustomizations(['nvidia-driver-535'], 'NVIDIA B300', false)).rejects.toThrow(
          /not compatible with this device/,
        );
      });

      it('rejects driver-535 on B200 (not in B200 eligible set)', async () => {
        await expect(service.validateCustomizations(['nvidia-driver-535'], 'NVIDIA B200 SXM', false)).rejects.toThrow(
          /not compatible with this device/,
        );
      });

      it('accepts driver-580 on B300 (in B300 eligible set)', async () => {
        await expect(
          service.validateCustomizations(['nvidia-driver-580'], 'NVIDIA B300', false),
        ).resolves.toBeUndefined();
      });

      it('rejects all driver/cuda choices when gpuModel is null (CPU-only device)', async () => {
        await expect(service.validateCustomizations(['nvidia-driver-535'], null, false)).rejects.toThrow(
          /not compatible with this device/,
        );
      });

      it('accepts mellanox-ofed on a CPU-only device', async () => {
        await expect(service.validateCustomizations(['mellanox-ofed'], null, false)).resolves.toBeUndefined();
      });

      it('rejects unknown GPU models entirely (no eligible set)', async () => {
        await expect(service.validateCustomizations(['nvidia-driver-580'], 'NVIDIA Tesla T4', false)).rejects.toThrow(
          /not compatible with this device/,
        );
      });

      it('accepts tee-setup only when teeEnabled and on a TEE-capable GPU', async () => {
        mockLayerFindMany.mockResolvedValueOnce([...ALL_LAYERS, { slug: 'tee-setup', kind: 'COMPONENT' }]);
        await expect(
          service.validateCustomizations(['tee-setup'], 'NVIDIA H100 SXM5 80GB', true),
        ).resolves.toBeUndefined();
      });

      it('rejects tee-setup when teeEnabled=false', async () => {
        mockLayerFindMany.mockResolvedValueOnce([...ALL_LAYERS, { slug: 'tee-setup', kind: 'COMPONENT' }]);
        await expect(service.validateCustomizations(['tee-setup'], 'NVIDIA H100 SXM5 80GB', false)).rejects.toThrow(
          /not compatible with this device/,
        );
      });
    });

    describe('per-artifact relations include arch when provided', () => {
      it('passes deviceArch through to the layerArtifact lookup', async () => {
        await service
          .validateCustomizations(
            ['nvidia-driver-580', 'cuda-13.0'],
            'NVIDIA H100 SXM5 80GB',
            false,
            'ubuntu-22.04',
            'amd64',
            LAYER_BUILD_ID,
          )
          .catch(() => {});
        const calls = mockArtifactFindMany.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const lastCall = calls[calls.length - 1][0];
        expect(lastCall.where.arch).toBe('amd64');
      });
    });
  });

  const lvmRow = (overrides: Partial<{ mountpoint: string; diskType: string; disks: string[] }> = {}): DiskLayout => ({
    config: 'lvm',
    format: 'ext4',
    mountpoint: '/',
    diskType: 'nvme',
    disks: ['nvme0n1'],
    wipe: true,
    ...overrides,
  });

  const raidRow = (
    overrides: Partial<{ config: string; mountpoint: string; diskType: string; disks: string[] }> = {},
  ): DiskLayout => ({
    config: 'raid1',
    format: 'ext4',
    mountpoint: '/',
    diskType: 'nvme',
    disks: ['nvme0n1', 'nvme1n1'],
    wipe: true,
    ...overrides,
  });

  const directRow = (overrides: Partial<{ mountpoint: string; format: DiskLayout['format'] }> = {}): DiskLayout => ({
    config: 'direct',
    format: 'ext4',
    mountpoint: '/',
    diskType: 'nvme',
    disks: ['nvme0n1'],
    wipe: true,
    ...overrides,
  });

  const storageDrive = (overrides: Partial<StorageDrive> & { name: string }): StorageDrive => ({
    id: `drive-${overrides.name}`,
    deviceId: 'device-1',
    type: StorageDriveType.NVME,
    model: null,
    serial: null,
    wwn: null,
    sizeBytes: BigInt(1_000_000_000_000),
    physicalBlockBytes: null,
    busPath: null,
    storageController: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  describe('validateDiskLayouts — unique root mountpoint', () => {
    it('rejects a payload with two roots (lvm + lvm)', () => {
      expect(() =>
        service.validateDiskLayouts(
          [lvmRow({ mountpoint: '/' }), lvmRow({ mountpoint: '/', diskType: 'hdd', disks: ['sda'] })],
          'provision',
        ),
      ).toThrow(/Exactly one disk group must have mountpoint "\/"; got 2/);
    });

    it('rejects a payload with zero roots (all /data{N})', () => {
      expect(() =>
        service.validateDiskLayouts(
          [lvmRow({ mountpoint: '/data0' }), lvmRow({ mountpoint: '/data1', diskType: 'hdd', disks: ['sda'] })],
          'provision',
        ),
      ).toThrow(/got 0/);
    });

    it('rejects a single-row payload with no root', () => {
      expect(() => service.validateDiskLayouts([lvmRow({ mountpoint: '/data0' })], 'provision')).toThrow(/got 0/);
    });

    it('rejects two roots even when one of them is raid', () => {
      expect(() =>
        service.validateDiskLayouts(
          [raidRow({ config: 'raid1', mountpoint: '/' }), lvmRow({ mountpoint: '/', diskType: 'hdd', disks: ['sda'] })],
          'provision',
        ),
      ).toThrow(/got 2/);
    });

    it('no-op on empty arrays', () => {
      expect(() => service.validateUniqueRootMountpoint([])).not.toThrow();
    });
  });

  describe('validateMountpoint — shell-metacharacter rejection', () => {
    it('accepts safe absolute paths', () => {
      for (const mp of ['/', '/data', '/data0', '/mnt/data', '/a-b_c.d']) {
        expect(() => service.validateMountpoint(mp)).not.toThrow();
      }
    });

    it('rejects mountpoints carrying shell metacharacters or whitespace', () => {
      for (const mp of [`/data'; rm -rf / #`, '/data$(id)', '/data`whoami`', '/da ta', '/data&', '/data|x']) {
        expect(() => service.validateMountpoint(mp)).toThrow(BadRequestException);
      }
    });

    it('rejects mountpoints with empty path segments', () => {
      for (const mp of ['//', '/boot/', '/mnt//data']) {
        expect(() => service.validateMountpoint(mp)).toThrow(BadRequestException);
      }
    });
  });

  describe('validateDiskLayouts — direct consistency', () => {

    it('no-op when no row uses direct', () => {
      expect(() =>
        service.validateDiskLayouts(
          [lvmRow({ mountpoint: '/' }), lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['sda'] })],
          'provision',
        ),
      ).not.toThrow();
    });

    it('accepts a single-entry direct payload mounted at /', () => {
      expect(() => service.validateDiskLayouts([directRow()], 'provision')).not.toThrow();
    });

    it('rejects a multi-entry payload that contains direct', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            directRow(),
            { config: 'lvm', format: 'ext4', mountpoint: '/data0', diskType: 'hdd', disks: ['sda'], wipe: true },
          ],
          'provision',
        ),
      ).toThrow(/must contain exactly one disk group/);
    });

    it('rejects a direct entry with a non-/ mountpoint', () => {
      expect(() => service.validateDiskLayouts([directRow({ mountpoint: '/data0' })], 'provision')).toThrow(
        /mountpoint must be "\/"/,
      );
    });

    it('rejects two direct entries even when both are direct', () => {
      expect(() =>
        service.validateDiskLayouts(
          [directRow({ mountpoint: '/' }), directRow({ mountpoint: '/data0', format: 'ext4' })],
          'provision',
        ),
      ).toThrow(/got 2/);
    });
  });

  describe('validateDiskLayouts — encrypt / wipe safety', () => {
    const RESTRICTED = ['/', '/home', '/tmp', '/usr', '/var'];

    it('rejects wipe:false on initial provision (no data to preserve)', () => {
      expect(() => service.validateDiskLayouts([{ ...lvmRow({ mountpoint: '/' }), wipe: false }], 'provision')).toThrow(
        /Cannot preserve disks on initial provision/,
      );
    });

    it('rejects encrypt:true + wipe:false on reprovision (encryption requires a fresh format)', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            lvmRow({ mountpoint: '/' }),
            { ...lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['sda'] }), encrypt: true, wipe: false },
          ],
          'reprovision',
        ),
      ).toThrow(/Cannot encrypt a preserved disk group/);
    });

    for (const mountpoint of RESTRICTED) {
      it(`rejects encrypt:true on restricted mountpoint ${mountpoint} (provision)`, () => {
        const layouts =
          mountpoint === '/'
            ? [{ ...lvmRow({ mountpoint: '/' }), encrypt: true }]
            : [
                lvmRow({ mountpoint: '/' }),
                { ...lvmRow({ mountpoint, diskType: 'hdd', disks: ['sda'] }), encrypt: true },
              ];
        expect(() => service.validateDiskLayouts(layouts, 'provision')).toThrow(
          new RegExp(`Encryption is not supported on system mountpoint "${mountpoint}"`),
        );
      });

      it(`rejects encrypt:true on restricted mountpoint ${mountpoint} (reprovision)`, () => {
        const layouts =
          mountpoint === '/'
            ? [{ ...lvmRow({ mountpoint: '/' }), encrypt: true }]
            : [
                lvmRow({ mountpoint: '/' }),
                { ...lvmRow({ mountpoint, diskType: 'hdd', disks: ['sda'] }), encrypt: true },
              ];
        expect(() => service.validateDiskLayouts(layouts, 'reprovision')).toThrow(
          /Encryption is not supported on system mountpoint/,
        );
      });
    }

    it('accepts encrypt:true on /data (provision)', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            lvmRow({ mountpoint: '/' }),
            { ...lvmRow({ mountpoint: '/data', diskType: 'hdd', disks: ['sda'] }), encrypt: true },
          ],
          'provision',
        ),
      ).not.toThrow();
    });

    it('accepts reprovision + wipe:false + encrypt:false (plain preserve)', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            lvmRow({ mountpoint: '/' }),
            { ...lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['sda'] }), wipe: false, encrypt: false },
          ],
          'reprovision',
        ),
      ).not.toThrow();
    });

    it('rejects wipe:false on the root "/" group (reprovision)', () => {
      expect(() =>
        service.validateDiskLayouts([{ ...lvmRow({ mountpoint: '/' }), wipe: false }], 'reprovision'),
      ).toThrow(/Cannot preserve the root "\/" disk group/);
    });

    it('accepts reprovision wiping "/" while preserving a data group', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            { ...lvmRow({ mountpoint: '/' }), wipe: true },
            { ...lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['sda'] }), wipe: false },
          ],
          'reprovision',
        ),
      ).not.toThrow();
    });
  });

  describe('validateDiskLayouts — duplicate disk across groups', () => {
    it('rejects the same disk appearing in two groups (wipe vs preserve = data-loss hazard)', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            { ...lvmRow({ mountpoint: '/' }), wipe: true },
            { ...lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['nvme0n1'] }), wipe: false },
          ],
          'reprovision',
        ),
      ).toThrow(/appears in more than one disk group/);
    });

    it('rejects the same disk listed twice even within the same wipe semantics', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            raidRow({ mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] }),
            lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['nvme1n1'] }),
          ],
          'provision',
        ),
      ).toThrow(/"nvme1n1" appears in more than one disk group/);
    });

    it('accepts distinct disks across groups', () => {
      expect(() =>
        service.validateDiskLayouts(
          [
            lvmRow({ mountpoint: '/', disks: ['nvme0n1'] }),
            lvmRow({ mountpoint: '/data0', diskType: 'hdd', disks: ['sda'] }),
          ],
          'provision',
        ),
      ).not.toThrow();
    });
  });

  describe('validateDiskLayouts — RAID minimum disk count', () => {
    const cases: Array<{ config: string; tooFew: string[]; ok: string[] }> = [
      { config: 'raid0', tooFew: ['a'], ok: ['a', 'b'] },
      { config: 'raid5', tooFew: ['a', 'b'], ok: ['a', 'b', 'c'] },
      { config: 'raid6', tooFew: ['a', 'b', 'c'], ok: ['a', 'b', 'c', 'd'] },
      { config: 'raid50', tooFew: ['a', 'b', 'c', 'd'], ok: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { config: 'raid60', tooFew: ['a', 'b', 'c', 'd', 'e', 'f'], ok: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
    ];

    for (const { config, tooFew, ok } of cases) {
      it(`rejects ${config} with too few disks (${tooFew.length})`, () => {
        expect(() =>
          service.validateDiskLayouts([raidRow({ config, mountpoint: '/', disks: tooFew })], 'provision'),
        ).toThrow(/requires at least/);
      });

      it(`accepts ${config} with a valid disk count (${ok.length})`, () => {
        expect(() =>
          service.validateDiskLayouts([raidRow({ config, mountpoint: '/', disks: ok })], 'provision'),
        ).not.toThrow();
      });
    }

    it('rejects raid10 with an odd disk count (>= minimum)', () => {
      expect(() =>
        service.validateDiskLayouts(
          [raidRow({ config: 'raid10', mountpoint: '/', disks: ['a', 'b', 'c', 'd', 'e'] })],
          'provision',
        ),
      ).toThrow(/even number of disks/);
    });

    it('accepts raid10 with four disks', () => {
      expect(() =>
        service.validateDiskLayouts(
          [raidRow({ config: 'raid10', mountpoint: '/', disks: ['a', 'b', 'c', 'd'] })],
          'provision',
        ),
      ).not.toThrow();
    });
  });

  describe('validateDiskGroupHomogeneity', () => {
    it('rejects a raid1 group mixing NVME and HDD types', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).toThrow(
        new BadRequestException(
          'Disk group "/" mixes disk types: "nvme0n1" is NVME but "nvme1n1" is HDD. All disks in a disk group must be the same type.',
        ),
      );
    });

    it('rejects a raid1 group with matching type but different sizes', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', sizeBytes: BigInt(1_000_000_000_000) }),
        storageDrive({ name: 'nvme1n1', sizeBytes: BigInt(2_000_000_000_000) }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).toThrow(/mixes disk sizes: "nvme0n1" is 1000000000000 bytes but "nvme1n1" is 2000000000000 bytes/);
    });

    it('accepts a raid1 group with matching type and size', () => {
      const drives = [storageDrive({ name: 'nvme0n1' }), storageDrive({ name: 'nvme1n1' })];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('rejects a group whose members have matching type/size but different models', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: 'Micron 7450' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).toThrow(/mixes disk models: "nvme0n1" is "Samsung PM9A3" but "nvme1n1" is "Micron 7450"/);
    });

    it('accepts a group whose members share the same model', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: 'Samsung PM9A3' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('does not flag a model mismatch when one member has an unknown (null) model', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: null }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('treats models differing only in case as equal', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: 'SAMSUNG pm9a3' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('does not flag a model mismatch when one member has a blank ("") model (lsblk unknown)', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: '' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('does not flag a model mismatch when one member has a whitespace-only model', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: '   ' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('treats space-padded models as equal (lsblk padding must not split identical drives)', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: 'Samsung PM9A3   ' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          drives,
        ),
      ).not.toThrow();
    });

    it('detects a model mismatch on a disk beyond the second member', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme1n1', model: 'Samsung PM9A3' }),
        storageDrive({ name: 'nvme2n1', model: 'Micron 7450' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid5', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1', 'nvme2n1'] })],
          drives,
        ),
      ).toThrow(/mixes disk models: "nvme0n1" is "Samsung PM9A3" but "nvme2n1" is "Micron 7450"/);
    });

    it('rejects a disk that is not among the known storage drives', () => {
      const drives = [storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME })];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'unknown-disk'] })],
          drives,
        ),
      ).toThrow(/does not match a known disk/);
    });

    it('rejects a RAID group when no storage drives are known', () => {
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })],
          [],
        ),
      ).toThrow(/does not match a known disk/);
    });

    it('accepts a multi-disk lvm group with mixed disk types', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.SSD, sizeBytes: BigInt(500), model: 'Samsung' }),
        storageDrive({ name: 'sda', type: StorageDriveType.HDD, sizeBytes: BigInt(9000), model: 'Seagate' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity([lvmRow({ mountpoint: '/', disks: ['nvme0n1', 'sda'] })], drives),
      ).not.toThrow();
    });

    it('accepts a single-disk lvm group regardless of drive data', () => {
      const drives = [storageDrive({ name: 'nvme0n1', type: StorageDriveType.HDD, sizeBytes: BigInt(1) })];
      expect(() => service.validateDiskGroupHomogeneity([lvmRow()], drives)).not.toThrow();
    });

    it('ignores single-disk (direct) layouts regardless of drive data', () => {
      const drives = [storageDrive({ name: 'nvme0n1', type: StorageDriveType.HDD, sizeBytes: BigInt(1) })];
      expect(() => service.validateDiskGroupHomogeneity([directRow()], drives)).not.toThrow();
    });

    it('matches disk identifiers by serial or wwn, not just name', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', serial: 'SERIAL-A', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', wwn: 'WWN-B', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['SERIAL-A', 'WWN-B'] })],
          drives,
        ),
      ).toThrow(/mixes disk types/);
    });

    it('rejects a serial or WWN that matches multiple disks', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', serial: 'DUPLICATE' }),
        storageDrive({ name: 'nvme1n1', wwn: 'DUPLICATE' }),
        storageDrive({ name: 'nvme2n1' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['DUPLICATE', 'nvme2n1'] })],
          drives,
        ),
      ).toThrow(/matches multiple disks by serial or WWN/);
    });

    it('rejects two identifiers that resolve to the same disk', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', serial: 'SERIAL-A' }),
        storageDrive({ name: 'nvme1n1' }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'SERIAL-A'] })],
          drives,
        ),
      ).toThrow(/references disk "nvme0n1" more than once/);
    });

    it('annotates the caller identifier in the error when disks are matched by serial/wwn', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', serial: 'SERIAL-A', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', wwn: 'WWN-B', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['SERIAL-A', 'WWN-B'] })],
          drives,
        ),
      ).toThrow(/"nvme0n1" \(matched via "SERIAL-A"\) is NVME but "nvme1n1" \(matched via "WWN-B"\) is HDD/);
    });

    it('resolves by name authoritatively so a colliding serial cannot shadow another drive', () => {
      const drives = [
        storageDrive({ name: 'S4DYNX', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', serial: 'S4DYNX', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid1', mountpoint: '/', disks: ['S4DYNX', 'nvme1n1'] })],
          drives,
        ),
      ).toThrow(/mixes disk types/);
    });

    it('detects a mismatch on a disk beyond the second member (raid5, odd one out)', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme2n1', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid5', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1', 'nvme2n1'] })],
          drives,
        ),
      ).toThrow(/mixes disk types: "nvme0n1" is NVME but "nvme2n1" is HDD/);
    });

    it('detects a size mismatch on a disk beyond the second member', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', sizeBytes: BigInt(1_000_000_000_000) }),
        storageDrive({ name: 'nvme1n1', sizeBytes: BigInt(1_000_000_000_000) }),
        storageDrive({ name: 'nvme2n1', sizeBytes: BigInt(2_000_000_000_000) }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [raidRow({ config: 'raid5', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1', 'nvme2n1'] })],
          drives,
        ),
      ).toThrow(/mixes disk sizes: "nvme0n1" .* but "nvme2n1" is 2000000000000 bytes/);
    });

    it('rejects a mismatched RAID group that is not the first layout in the payload', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'sda', type: StorageDriveType.SSD }),
        storageDrive({ name: 'sdb', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [
            raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] }),
            raidRow({ config: 'raid1', mountpoint: '/data0', disks: ['sda', 'sdb'] }),
          ],
          drives,
        ),
      ).toThrow(/Disk group "\/data0" mixes disk types/);
    });

    it('accepts a heterogeneous LVM group alongside a valid RAID group', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'sda', type: StorageDriveType.SSD }),
        storageDrive({ name: 'sdb', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [
            raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] }),
            lvmRow({ mountpoint: '/data0', disks: ['sda', 'sdb'] }),
          ],
          drives,
        ),
      ).not.toThrow();
    });

    it('accepts a payload of multiple homogeneous multi-disk groups', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'sda', type: StorageDriveType.HDD }),
        storageDrive({ name: 'sdb', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validateDiskGroupHomogeneity(
          [
            raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] }),
            lvmRow({ mountpoint: '/data0', disks: ['sda', 'sdb'] }),
          ],
          drives,
        ),
      ).not.toThrow();
    });
  });

  describe('validate — provision bundle', () => {
    const provisionRequest = (diskLayouts: DiskLayout[]): ProvisionRequest =>
      ({
        deploymentName: 'box',
        operatingSystem: 'ubuntu-22.04',
        sshKeyIds: ['k1'],
        diskLayouts,
        ipxeUrl: null,
      }) as ProvisionRequest;

    it('runs the homogeneity check as part of the bundle (rejects a mismatched group)', () => {
      const drives = [
        storageDrive({ name: 'nvme0n1', type: StorageDriveType.NVME }),
        storageDrive({ name: 'nvme1n1', type: StorageDriveType.HDD }),
      ];
      expect(() =>
        service.validate(
          provisionRequest([raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })]),
          drives,
        ),
      ).toThrow(/mixes disk types/);
    });

    it('passes a valid request whose disks are homogeneous', () => {
      const drives = [storageDrive({ name: 'nvme0n1' }), storageDrive({ name: 'nvme1n1' })];
      expect(() =>
        service.validate(
          provisionRequest([raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] })]),
          drives,
        ),
      ).not.toThrow();
    });

    it('still enforces structural rules before homogeneity (rejects wipe:false on provision)', () => {
      const drives = [storageDrive({ name: 'nvme0n1' }), storageDrive({ name: 'nvme1n1' })];
      const layout = { ...raidRow({ config: 'raid1', mountpoint: '/', disks: ['nvme0n1', 'nvme1n1'] }), wipe: false };
      expect(() => service.validate(provisionRequest([layout]), drives)).toThrow(
        /Cannot preserve disks on initial provision/,
      );
    });
  });
});
