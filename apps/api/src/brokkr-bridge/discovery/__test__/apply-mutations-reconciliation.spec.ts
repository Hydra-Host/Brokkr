import { GpuVendor } from '@repo/database';
import type { LoggerService } from 'src/logger/logger.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMutations } from '../apply-mutations';

const silentLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
} as unknown as LoggerService;

const DEVICE_ID = 'device-uuid-1';

const makeHarness = ({
  drivesRemoved = 0,
  gpusRemoved = 0,
  edgesRemoved = 0,
}: { drivesRemoved?: number; gpusRemoved?: number; edgesRemoved?: number } = {}) => {
  const storageDriveUpsert = vi.fn();
  const storageDriveDeleteMany = vi.fn().mockResolvedValue({ count: drivesRemoved });
  const gpuUpsert = vi.fn();
  const gpuDeleteMany = vi.fn().mockResolvedValue({ count: gpusRemoved });
  const nvlinkDeleteMany = vi.fn().mockResolvedValue({ count: edgesRemoved });

  const tx = {
    device: { update: vi.fn() },
    cpu: { upsert: vi.fn() },
    gpu: { upsert: gpuUpsert, deleteMany: gpuDeleteMany },
    nvlinkEdge: { upsert: vi.fn(), deleteMany: nvlinkDeleteMany },
    storageDrive: { upsert: storageDriveUpsert, deleteMany: storageDriveDeleteMany },
    memoryConfig: { upsert: vi.fn() },
  };

  const prisma = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaClient;

  return {
    prisma,
    storageDriveUpsert,
    storageDriveDeleteMany,
    gpuUpsert,
    gpuDeleteMany,
    nvlinkDeleteMany,
    driveRemoveArgs: () => storageDriveDeleteMany.mock.calls.map((call) => (call[0] as { where: unknown }).where),
    gpuRemoveArgs: () => gpuDeleteMany.mock.calls.map((call) => (call[0] as { where: unknown }).where),
  };
};

describe('applyMutations — StorageDrive reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes rows this run did not report, so a pulled disk cannot linger', async () => {
    const harness = makeHarness({ drivesRemoved: 1 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { storageDrives: [{ name: 'nvme0n1', type: 'NVME', sizeBytes: 3_840_000_000_000n }] } },
      silentLogger,
    );

    expect(harness.driveRemoveArgs()).toEqual([{ deviceId: DEVICE_ID, name: { notIn: ['nvme0n1'] } }]);
    expect(result.upsertCounts['storageDrives:removed']).toBe(1);
  });

  it('spares every reported drive when two collectors both report the same disk', async () => {
    const harness = makeHarness();

    await applyMutations(
      harness.prisma,
      DEVICE_ID,
      {
        upserts: {
          storageDrives: [
            { name: 'nvme0n1', type: 'NVME', sizeBytes: 1n },
            { name: 'nvme0n1', type: 'NVME', sizeBytes: 1n, busPath: 'pci-0000:04:00.0' },
            { name: 'sda', type: 'SSD', sizeBytes: 2n },
          ],
        },
      },
      silentLogger,
    );

    expect(harness.driveRemoveArgs()).toEqual([
      { deviceId: DEVICE_ID, name: { notIn: ['nvme0n1', 'nvme0n1', 'sda'] } },
    ]);
  });

  it('does not delete when no storage collector reported, so a dropped collector cannot wipe inventory', async () => {
    const harness = makeHarness();

    await applyMutations(harness.prisma, DEVICE_ID, { upserts: { storageDrives: [] } }, silentLogger);

    expect(harness.storageDriveUpsert).not.toHaveBeenCalled();
    expect(harness.storageDriveDeleteMany).not.toHaveBeenCalled();
  });

  it('omits the removed count when nothing was stale', async () => {
    const harness = makeHarness({ drivesRemoved: 0 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { storageDrives: [{ name: 'nvme0n1', type: 'NVME', sizeBytes: 1n }] } },
      silentLogger,
    );

    expect(harness.storageDriveDeleteMany).toHaveBeenCalledTimes(1);
    expect(result.upsertCounts['storageDrives:removed']).toBeUndefined();
  });
});

describe('applyMutations — Gpu reconciliation', () => {
  const gpu = (index: number) => ({ index, model: 'NVIDIA H100', vendor: GpuVendor.NVIDIA });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes indices this run did not report, since the upsert alone never lowers the gpu count', async () => {
    const harness = makeHarness({ gpusRemoved: 2 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { gpus: [gpu(0), gpu(1)] } },
      silentLogger,
    );

    expect(harness.gpuRemoveArgs()).toEqual([{ deviceId: DEVICE_ID, index: { notIn: [0, 1] } }]);
    expect(result.upsertCounts['gpus:removed']).toBe(2);
  });

  it('does not delete when an empty nvidia collector reported no GPUs', async () => {
    const harness = makeHarness();

    await applyMutations(harness.prisma, DEVICE_ID, { upserts: { gpus: [] } }, silentLogger);

    expect(harness.gpuUpsert).not.toHaveBeenCalled();
    expect(harness.gpuDeleteMany).not.toHaveBeenCalled();
  });

  it('omits the removed count when nothing was stale', async () => {
    const harness = makeHarness({ gpusRemoved: 0 });

    const result = await applyMutations(harness.prisma, DEVICE_ID, { upserts: { gpus: [gpu(0)] } }, silentLogger);

    expect(harness.gpuDeleteMany).toHaveBeenCalledTimes(1);
    expect(result.upsertCounts['gpus:removed']).toBeUndefined();
  });

  it('sweeps nvlink edges pointing at a swept card, since NvlinkEdge holds no Gpu fk to cascade', async () => {
    const harness = makeHarness({ gpusRemoved: 1, edgesRemoved: 3 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { gpus: [gpu(0), gpu(1)] } },
      silentLogger,
    );

    expect(harness.nvlinkDeleteMany).toHaveBeenCalledWith({
      where: {
        deviceId: DEVICE_ID,
        OR: [{ sourceGpuIndex: { notIn: [0, 1] } }, { targetGpuIndex: { notIn: [0, 1] } }],
      },
    });
    expect(result.upsertCounts['nvlinkEdges:removed']).toBe(3);
  });

  it('does not sweep edges when an empty nvidia report swept no cards', async () => {
    const harness = makeHarness();

    await applyMutations(harness.prisma, DEVICE_ID, { upserts: { gpus: [] } }, silentLogger);

    expect(harness.nvlinkDeleteMany).not.toHaveBeenCalled();
  });
});
