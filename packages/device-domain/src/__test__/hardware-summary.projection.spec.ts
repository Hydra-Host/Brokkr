import { StorageDriveType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  type HardwareSummary,
  type HardwareSummaryInput,
  projectHardwareSummary,
} from '../hardware-summary.projection';

const GB = 1024 ** 3;

const emptyInput: HardwareSummaryInput = {
  cpus: [],
  gpus: [],
  storageDrives: [],
  memoryConfig: null,
};

const allNull: HardwareSummary = {
  cpuModel: null,
  cpuPhysicalCount: null,
  cpuCoreCount: null,
  cpuThreadCount: null,
  architecture: null,
  memoryGb: null,
  gpuModel: null,
  gpuCount: null,
  nvmeSize: null,
  nvmeCount: null,
  ssdSize: null,
  ssdCount: null,
  hddSize: null,
  hddCount: null,
};

describe('projectHardwareSummary', () => {
  describe('empty input', () => {
    it('returns all-null when every relation is empty', () => {
      expect(projectHardwareSummary(emptyInput)).toEqual(allNull);
    });
  });

  describe('cpu projection', () => {
    it('returns cpuModel/architecture from socket 0 for a single socket', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        cpus: [{ model: 'AMD EPYC 9654', architecture: 'x86_64', coreCount: 96, threadCount: 192 }],
      });

      expect(result.cpuModel).toBe('AMD EPYC 9654');
      expect(result.architecture).toBe('x86_64');
      expect(result.cpuPhysicalCount).toBe(1);
      expect(result.cpuCoreCount).toBe(96);
      expect(result.cpuThreadCount).toBe(192);
    });

    it('sums cores/threads across sockets for dual-socket hosts', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        cpus: [
          { model: 'INTEL XEON GOLD 6548Y+', architecture: 'x86_64', coreCount: 32, threadCount: 64 },
          { model: 'INTEL XEON GOLD 6548Y+', architecture: 'x86_64', coreCount: 32, threadCount: 64 },
        ],
      });

      expect(result.cpuModel).toBe('INTEL XEON GOLD 6548Y+');
      expect(result.cpuPhysicalCount).toBe(2);
      expect(result.cpuCoreCount).toBe(64);
      expect(result.cpuThreadCount).toBe(128);
    });

    it('returns null for core/thread sums when every socket reports null', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        cpus: [{ model: 'unknown', architecture: null, coreCount: null, threadCount: null }],
      });

      expect(result.cpuModel).toBe('unknown');
      expect(result.cpuPhysicalCount).toBe(1);
      expect(result.cpuCoreCount).toBeNull();
      expect(result.cpuThreadCount).toBeNull();
      expect(result.architecture).toBeNull();
    });
  });

  describe('gpu projection', () => {
    it('counts GPUs and exposes the first model', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        gpus: [{ model: 'NVIDIA H100 80GB HBM3' }, { model: 'NVIDIA H100 80GB HBM3' }],
      });

      expect(result.gpuModel).toBe('NVIDIA H100 80GB HBM3');
      expect(result.gpuCount).toBe(2);
    });

    it('returns first GPU model for heterogeneous configs (legacy behavior)', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        gpus: [{ model: 'NVIDIA H100 80GB HBM3' }, { model: 'NVIDIA A100 40GB' }],
      });

      expect(result.gpuModel).toBe('NVIDIA H100 80GB HBM3');
      expect(result.gpuCount).toBe(2);
    });
  });

  describe('memory projection', () => {
    it('converts totalSizeMb to GB', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        memoryConfig: { totalSizeMb: 524_288 },
      });

      expect(result.memoryGb).toBe(512);
    });
  });

  describe('storage projection', () => {
    it('sums per-drive rounded GiB by type', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        storageDrives: [
          { type: StorageDriveType.NVME, sizeBytes: BigInt(7681501126656) },
          { type: StorageDriveType.NVME, sizeBytes: BigInt(7681501126656) },
          { type: StorageDriveType.SSD, sizeBytes: BigInt(240057409536) },
        ],
      });

      expect(result.nvmeSize).toBe(2 * Math.round(7681501126656 / GB));
      expect(result.nvmeCount).toBe(2);
      expect(result.ssdSize).toBe(Math.round(240057409536 / GB));
      expect(result.ssdCount).toBe(1);
      expect(result.hddSize).toBe(0);
      expect(result.hddCount).toBe(0);
    });

    it('returns null for every storage field when storageDrives is empty', () => {
      const result = projectHardwareSummary({ ...emptyInput });

      expect(result.nvmeSize).toBeNull();
      expect(result.nvmeCount).toBeNull();
      expect(result.ssdSize).toBeNull();
      expect(result.ssdCount).toBeNull();
      expect(result.hddSize).toBeNull();
      expect(result.hddCount).toBeNull();
    });

    it('returns 0 for absent type when storageDrives has only one type', () => {
      const result = projectHardwareSummary({
        ...emptyInput,
        storageDrives: [{ type: StorageDriveType.NVME, sizeBytes: BigInt(1024 ** 4) }],
      });

      expect(result.nvmeSize).toBe(1024);
      expect(result.nvmeCount).toBe(1);
      expect(result.ssdSize).toBe(0);
      expect(result.ssdCount).toBe(0);
      expect(result.hddSize).toBe(0);
      expect(result.hddCount).toBe(0);
    });
  });

  describe('full aggregate', () => {
    it('projects a realistic GPU-host shape end-to-end', () => {
      const result = projectHardwareSummary({
        cpus: [
          { model: 'INTEL XEON GOLD 6548Y+', architecture: 'x86_64', coreCount: 32, threadCount: 64 },
          { model: 'INTEL XEON GOLD 6548Y+', architecture: 'x86_64', coreCount: 32, threadCount: 64 },
        ],
        gpus: Array.from({ length: 8 }, () => ({ model: 'NVIDIA H100 80GB HBM3' })),
        storageDrives: [
          { type: StorageDriveType.NVME, sizeBytes: BigInt(3_840_000_000_000) },
          { type: StorageDriveType.NVME, sizeBytes: BigInt(3_840_000_000_000) },
        ],
        memoryConfig: { totalSizeMb: 2 * 1024 * 1024 },
      });

      expect(result).toEqual<HardwareSummary>({
        cpuModel: 'INTEL XEON GOLD 6548Y+',
        cpuPhysicalCount: 2,
        cpuCoreCount: 64,
        cpuThreadCount: 128,
        architecture: 'x86_64',
        memoryGb: 2048,
        gpuModel: 'NVIDIA H100 80GB HBM3',
        gpuCount: 8,
        nvmeSize: 7152,
        nvmeCount: 2,
        ssdSize: 0,
        ssdCount: 0,
        hddSize: 0,
        hddCount: 0,
      });
    });
  });
});
