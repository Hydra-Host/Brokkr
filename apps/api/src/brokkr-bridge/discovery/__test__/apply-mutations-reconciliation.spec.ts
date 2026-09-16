import { GpuVendor } from '@repo/database';
import { formatMacAddress } from '@repo/database/extensions/mac-address';
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

interface IfaceRow {
  id: string;
  name: string;
  macAddress: string | null;
}

interface IfaceWhere {
  name?: string;
  macAddress?: { equals: string };
  id?: { not: string };
}

const makeHarness = ({
  drivesRemoved = 0,
  gpusRemoved = 0,
  edgesRemoved = 0,
  interfaces = [],
}: { drivesRemoved?: number; gpusRemoved?: number; edgesRemoved?: number; interfaces?: IfaceRow[] } = {}) => {
  const storageDriveUpsert = vi.fn();
  const storageDriveDeleteMany = vi.fn().mockResolvedValue({ count: drivesRemoved });
  const gpuUpsert = vi.fn();
  const gpuDeleteMany = vi.fn().mockResolvedValue({ count: gpusRemoved });
  const nvlinkDeleteMany = vi.fn().mockResolvedValue({ count: edgesRemoved });

  const ifaceRows = interfaces.map((row) => ({ ...row }));
  let ifaceSeq = 0;
  const storedMac = (mac: string | null | undefined) => (typeof mac === 'string' ? formatMacAddress(mac) : null);
  const interfaceFindFirst = vi.fn(async ({ where }: { where: IfaceWhere }) => {
    const row = ifaceRows.find(
      (r) =>
        (where.name === undefined || r.name === where.name) &&
        (where.macAddress === undefined || r.macAddress?.toLowerCase() === where.macAddress.equals.toLowerCase()) &&
        (where.id === undefined || r.id !== where.id.not),
    );
    return row ? { id: row.id, name: row.name } : null;
  });
  const interfaceUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<IfaceRow> }) => {
    const row = ifaceRows.find((r) => r.id === where.id);
    if (row && data.name !== undefined) row.name = data.name;
    if (row && data.macAddress !== undefined) row.macAddress = storedMac(data.macAddress);
    return { id: where.id };
  });
  const interfaceCreate = vi.fn(async ({ data }: { data: { name: string; macAddress?: string | null } }) => {
    const row = { id: `iface-${++ifaceSeq}`, name: data.name, macAddress: storedMac(data.macAddress) };
    ifaceRows.push(row);
    return { id: row.id };
  });

  const tx = {
    device: { update: vi.fn() },
    cpu: { upsert: vi.fn() },
    gpu: { upsert: gpuUpsert, deleteMany: gpuDeleteMany },
    nvlinkEdge: { upsert: vi.fn(), deleteMany: nvlinkDeleteMany },
    storageDrive: { upsert: storageDriveUpsert, deleteMany: storageDriveDeleteMany },
    memoryConfig: { upsert: vi.fn() },
    interface: { findFirst: interfaceFindFirst, update: interfaceUpdate, create: interfaceCreate },
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
    interfaceCreate,
    interfaceUpdate,
    ifaceRows,
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

describe('applyMutations — Interface reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates a renamed live row carrying the same MAC in place, under the live name', async () => {
    const harness = makeHarness({ interfaces: [{ id: 'if-1', name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:01' }] });

    await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { interfaces: [{ name: 'eno1', macAddress: 'AA-BB-CC-DD-EE-01' }] } },
      silentLogger,
    );

    expect(harness.interfaceCreate).not.toHaveBeenCalled();
    expect(harness.interfaceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'if-1' }, data: expect.objectContaining({ name: 'eno1' }) }),
    );
    expect(harness.ifaceRows.map((row) => row.name)).toEqual(['eno1']);
    expect(silentLogger.warn).not.toHaveBeenCalled();
  });

  it('stores a second interface reporting an already-written MAC without one and warns', async () => {
    const harness = makeHarness();

    await applyMutations(
      harness.prisma,
      DEVICE_ID,
      {
        upserts: {
          interfaces: [
            { name: 'bond0', macAddress: 'aa:bb:cc:dd:ee:01' },
            { name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:01' },
          ],
        },
      },
      silentLogger,
    );

    expect(harness.interfaceUpdate).not.toHaveBeenCalled();
    expect(harness.ifaceRows).toEqual([
      { id: 'iface-1', name: 'bond0', macAddress: 'aa:bb:cc:dd:ee:01' },
      { id: 'iface-2', name: 'eth0', macAddress: null },
    ]);
    expect(silentLogger.warn).toHaveBeenCalledTimes(1);
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('bond0 and eth0'));
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('aa:bb:cc:dd:ee:01'));
  });

  it('leaves the MAC on the live row that already holds it when a name-matched interface reports it', async () => {
    const harness = makeHarness({
      interfaces: [
        { id: 'if-1', name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:01' },
        { id: 'if-2', name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:02' },
      ],
    });

    await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { interfaces: [{ name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:01' }] } },
      silentLogger,
    );

    expect(harness.interfaceCreate).not.toHaveBeenCalled();
    expect(harness.interfaceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'if-2' },
        data: expect.objectContaining({ name: 'eth1', macAddress: null }),
      }),
    );
    expect(harness.ifaceRows.find((row) => row.id === 'if-1')?.macAddress).toBe('aa:bb:cc:dd:ee:01');
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('eth0 and eth1'));
  });
});
