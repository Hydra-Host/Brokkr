import type { LoggerService } from 'src/logger/logger.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMutations } from '../apply-mutations';
import type { PciDeviceUpsert } from '../collectors/collector.types';

const DEVICE_ID = 'dev-1';

const fakeLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as LoggerService;

const pci = (address: string, overrides: Partial<PciDeviceUpsert> = {}): PciDeviceUpsert => ({
  address,
  vendorId: '0x10de',
  vendorName: 'NVIDIA',
  productId: '0x2330',
  productName: 'H100',
  className: 'Processing accelerators',
  subclassName: null,
  driver: 'nvidia',
  subsystemVendorId: null,
  subsystemProductId: null,
  ...overrides,
});

interface RemoveWhere {
  deviceId: string;
  updatedAt: { lt: Date };
}

interface Harness {
  prisma: PrismaClient;
  inserts: () => unknown[][];
  pciDeviceUpsert: ReturnType<typeof vi.fn>;
  pciDeviceDeleteMany: ReturnType<typeof vi.fn>;
  removeArgs: () => RemoveWhere[];
  transactionCount: () => number;
}

const makeHarness = ({ removedCount = 0 }: { removedCount?: number } = {}): Harness => {
  const inserts: unknown[][] = [];
  const pciDeviceUpsert = vi.fn();
  const pciDeviceDeleteMany = vi.fn().mockResolvedValue({ count: removedCount });
  let transactions = 0;

  const $transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    transactions += 1;
    const tx = {
      device: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
      server: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      cpu: { upsert: vi.fn() },
      gpu: { upsert: vi.fn() },
      storageDrive: { upsert: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      memoryConfig: { upsert: vi.fn() },
      deviceFirmware: { upsert: vi.fn() },
      pciDevice: { upsert: pciDeviceUpsert, deleteMany: pciDeviceDeleteMany },
      uefiBootEntry: { upsert: vi.fn() },
      nvlinkEdge: { upsert: vi.fn() },
      deviceSolConfig: { upsert: vi.fn() },
      $executeRaw: vi.fn(async (...args: unknown[]) => void inserts.push(args)),
    };
    return cb(tx);
  });

  return {
    prisma: { $transaction } as unknown as PrismaClient,
    inserts: () => inserts,
    pciDeviceUpsert,
    pciDeviceDeleteMany,
    removeArgs: () => pciDeviceDeleteMany.mock.calls.map((c) => (c[0] as { where: RemoveWhere }).where),
    transactionCount: () => transactions,
  };
};

const isSqlFragment = (value: unknown): value is { values: unknown[] } =>
  typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown }).values);

const readStatement = (call: unknown[]): { sql: string; values: unknown[] } => {
  const [strings, ...interpolated] = call;
  return {
    sql: Array.isArray(strings) ? strings.join(' ? ') : String(strings),
    values: interpolated.flatMap((value) => (isSqlFragment(value) ? value.values : [value])),
  };
};

describe('applyMutations — batched PciDevice upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes every row in one statement instead of one round trip per row', async () => {
    const harness = makeHarness();
    const rows = Array.from({ length: 120 }, (_, i) => pci(`0000:${i.toString(16).padStart(2, '0')}:00.0`));

    const result = await applyMutations(harness.prisma, DEVICE_ID, { upserts: { pciDevices: rows } }, fakeLogger);

    expect(harness.inserts()).toHaveLength(1);
    expect(harness.pciDeviceUpsert).not.toHaveBeenCalled();
    expect(result.upsertCounts.pciDevices).toBe(120);
  });

  it('still commits inside the single shared transaction', async () => {
    const harness = makeHarness();

    await applyMutations(
      harness.prisma,
      DEVICE_ID,
      {
        deviceUpdate: { architecture: 'x86_64' },
        upserts: {
          storageDrives: [{ name: 'nvme0n1', type: 'NVME', sizeBytes: 1n }],
          pciDevices: [pci('0000:01:00.0')],
        },
      },
      fakeLogger,
    );

    expect(harness.transactionCount()).toBe(1);
  });

  it('chunks 1200 rows into 3 statements to stay under the per-statement bind-parameter budget', async () => {
    const harness = makeHarness();
    const rows = Array.from({ length: 1200 }, (_, i) => pci(`addr-${i}`));

    const result = await applyMutations(harness.prisma, DEVICE_ID, { upserts: { pciDevices: rows } }, fakeLogger);

    expect(harness.inserts()).toHaveLength(3);
    expect(result.upsertCounts.pciDevices).toBe(1200);
  });

  it('collapses duplicate addresses keeping the last occurrence, since Postgres aborts on a repeated conflict target', async () => {
    const harness = makeHarness();
    const rows = [
      pci('0000:01:00.0', { driver: 'first' }),
      pci('0000:02:00.0'),
      pci('0000:01:00.0', { driver: 'last' }),
    ];

    const result = await applyMutations(harness.prisma, DEVICE_ID, { upserts: { pciDevices: rows } }, fakeLogger);

    expect(result.upsertCounts.pciDevices).toBe(2);
    const { values } = readStatement(harness.inserts()[0]);
    expect(values).toContain('last');
    expect(values).not.toContain('first');
  });

  it('binds id and updatedAt explicitly and leaves createdAt to its DB default', async () => {
    const harness = makeHarness();

    await applyMutations(harness.prisma, DEVICE_ID, { upserts: { pciDevices: [pci('0000:01:00.0')] } }, fakeLogger);

    const { sql, values } = readStatement(harness.inserts()[0]);
    expect(sql).toContain('ON CONFLICT ("deviceId", "address") DO UPDATE');
    expect(sql).toContain('"updatedAt"          = EXCLUDED."updatedAt"');
    expect(sql).not.toContain('"createdAt"');
    expect(values.some((v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v))).toBe(true);
    expect(values.some((v) => v instanceof Date)).toBe(true);
  });

  it('leaves every non-null column reachable from EXCLUDED', async () => {
    const harness = makeHarness();

    await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { pciDevices: [pci('0000:01:00.0', { subsystemProductId: '0x1234' })] } },
      fakeLogger,
    );

    const { values } = readStatement(harness.inserts()[0]);
    expect(values).toContain('0000:01:00.0');
    expect(values).toContain('0x10de');
    expect(values).toContain('NVIDIA');
    expect(values).toContain('0x2330');
    expect(values).toContain('H100');
    expect(values).toContain('Processing accelerators');
    expect(values).toContain('nvidia');
    expect(values).toContain('0x1234');
    expect(values).toContain(null);
  });
});

describe('applyMutations — stale PciDevice removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes rows older than this run, scoped to the device', async () => {
    const harness = makeHarness({ removedCount: 3 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { pciDevices: [pci('0000:01:00.0'), pci('0000:02:00.0')] } },
      fakeLogger,
    );

    expect(harness.removeArgs()).toEqual([{ deviceId: DEVICE_ID, updatedAt: { lt: expect.any(Date) } }]);
    expect(result.upsertCounts['pciDevices:removed']).toBe(3);
  });

  it('deletes against the exact timestamp bound into the inserted rows, never a later instant', async () => {
    const harness = makeHarness();
    const rows = Array.from({ length: 700 }, (_, i) => pci(`addr-${i}`));

    await applyMutations(harness.prisma, DEVICE_ID, { upserts: { pciDevices: rows } }, fakeLogger);

    const insertStamps = harness
      .inserts()
      .flatMap((c) => readStatement(c).values.filter((v): v is Date => v instanceof Date))
      .map((d) => d.getTime());

    expect(new Set(insertStamps).size).toBe(1);
    expect(harness.removeArgs()[0].updatedAt.lt.getTime()).toBe(insertStamps[0]);
  });

  it('does not delete when the collector reported no devices at all', async () => {
    const harness = makeHarness();

    await applyMutations(harness.prisma, DEVICE_ID, { upserts: { pciDevices: [] } }, fakeLogger);

    expect(harness.inserts()).toHaveLength(0);
    expect(harness.pciDeviceDeleteMany).not.toHaveBeenCalled();
  });

  it('does not delete when the collector skipped malformed rows, since absence no longer proves removal', async () => {
    const harness = makeHarness({ removedCount: 4 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { pciDevices: [pci('0000:01:00.0')] }, pciDevicesPartial: true },
      fakeLogger,
    );

    expect(harness.inserts()).toHaveLength(1);
    expect(harness.pciDeviceDeleteMany).not.toHaveBeenCalled();
    expect(result.upsertCounts.pciDevices).toBe(1);
    expect(result.upsertCounts['pciDevices:removed']).toBeUndefined();
    expect(result.upsertCounts['pciDevices:prune-skipped']).toBe(1);
  });

  it('prunes when the scan was complete', async () => {
    const harness = makeHarness({ removedCount: 4 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { pciDevices: [pci('0000:01:00.0')] }, pciDevicesPartial: false },
      fakeLogger,
    );

    expect(harness.pciDeviceDeleteMany).toHaveBeenCalledTimes(1);
    expect(result.upsertCounts['pciDevices:removed']).toBe(4);
    expect(result.upsertCounts['pciDevices:prune-skipped']).toBeUndefined();
  });

  it('omits the removed count when nothing was stale', async () => {
    const harness = makeHarness({ removedCount: 0 });

    const result = await applyMutations(
      harness.prisma,
      DEVICE_ID,
      { upserts: { pciDevices: [pci('0000:01:00.0')] } },
      fakeLogger,
    );

    expect(harness.pciDeviceDeleteMany).toHaveBeenCalledTimes(1);
    expect(result.upsertCounts['pciDevices:removed']).toBeUndefined();
  });
});
