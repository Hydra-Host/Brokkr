import { DeviceRole } from '@repo/database';
import type { LoggerService } from 'src/logger/logger.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import { applyMutations } from '../apply-mutations';
import type { DeviceMutation } from '../collectors/collector.types';


const silentLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
} as unknown as LoggerService;

const DEVICE_ID = 'device-uuid-1';

interface TxMock {
  device: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  interface: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
}

const noHardwareRows = { cpus: [], gpus: [], storageDrives: [], memoryConfig: null };

const makeTx = (): TxMock => ({
  device: {
    update: vi.fn(),
    findUnique: vi.fn().mockResolvedValue({
      supplierId: null,
      zone: null,
      ...noHardwareRows,
    }),
  },
  interface: {
    create: vi.fn().mockResolvedValue({ id: 'iface-new' }),
    update: vi.fn().mockResolvedValue({ id: 'iface-existing' }),
    findFirst: vi.fn(),
  },
});

const makePrisma = <T>(tx: T): PrismaClient =>
  ({ $transaction: vi.fn(async (cb: (t: T) => Promise<unknown>) => cb(tx)) }) as unknown as PrismaClient;

describe('applyMutations — interface soft-delete (partial unique)', () => {
  it('creates a fresh live row on re-commission (no active match — tombstone excluded by deletedAt: null)', async () => {
    const tx = makeTx();
    tx.interface.findFirst.mockResolvedValue(null);
    const mutation: DeviceMutation = { upserts: { interfaces: [{ name: 'eno1' }] } };

    await applyMutations(makePrisma(tx), DEVICE_ID, mutation, silentLogger);

    expect(tx.interface.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deviceId: DEVICE_ID, name: 'eno1', deletedAt: null } }),
    );
    expect(tx.interface.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deviceId: DEVICE_ID, name: 'eno1' } }),
    );
    expect(tx.interface.update).not.toHaveBeenCalled();
  });

  it('updates the existing live row in place when one is already active', async () => {
    const tx = makeTx();
    tx.interface.findFirst.mockResolvedValue({ id: 'iface-existing' });
    const mutation: DeviceMutation = { upserts: { interfaces: [{ name: 'eno1' }] } };

    await applyMutations(makePrisma(tx), DEVICE_ID, mutation, silentLogger);

    expect(tx.interface.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'iface-existing' }, data: { name: 'eno1' } }),
    );
    expect(tx.interface.create).not.toHaveBeenCalled();
  });

  it('rename-adoption: adopts an active eth0 enrichment row carrying the same MAC', async () => {
    const tx = makeTx();
    tx.interface.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'enrichment-1' });
    const mutation: DeviceMutation = {
      upserts: { interfaces: [{ name: 'eno1', macAddress: 'AA:BB:CC:DD:EE:FF' }] },
    };

    await applyMutations(makePrisma(tx), DEVICE_ID, mutation, silentLogger);

    expect(tx.interface.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'enrichment-1' },
        data: { name: 'eno1', macAddress: 'AA:BB:CC:DD:EE:FF' },
      }),
    );
    expect(tx.interface.create).not.toHaveBeenCalled();
  });
});

interface ServerTxMock {
  device: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  server: {
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

const makeServerTx = (): ServerTxMock => ({
  device: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ ...noHardwareRows }) },
  server: {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    create: vi.fn().mockResolvedValue({}),
  },
});

describe('applyMutations — Server-extension write (discovery updates, never creates)', () => {
  const serverUpdate: DeviceMutation = { serverUpdate: { storageLayouts: { configs: [] } } };

  it('updates an existing Server row even when the device is role=null (commissioning awaiting acknowledge)', async () => {
    const tx = makeServerTx();

    const result = await applyMutations(makePrisma(tx), DEVICE_ID, serverUpdate, silentLogger);

    expect(tx.server.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deviceId: DEVICE_ID }, data: { storageLayouts: { configs: [] } } }),
    );
    expect(tx.server.create).not.toHaveBeenCalled();
    expect(result.upsertCounts['serverUpdate:skipped']).toBeUndefined();
  });

  it.each([
    ['role=null (unacknowledged commissioning)', null],
    ['Server', DeviceRole.Server],
    ['Bridge', DeviceRole.Bridge],
  ] as const)('does not create a Server row when none exists (%s)', async (_label, _role) => {
    const tx = makeServerTx();
    tx.server.updateMany.mockResolvedValue({ count: 0 });

    const result = await applyMutations(makePrisma(tx), DEVICE_ID, serverUpdate, silentLogger);

    expect(tx.server.create).not.toHaveBeenCalled();
    expect(tx.server.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deviceId: DEVICE_ID } }));
    expect(result.upsertCounts['serverUpdate:skipped']).toBe(1);
  });
});
