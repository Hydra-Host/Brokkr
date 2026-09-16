import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CommissioningDeviceInput } from '@repo/api-client';
import {
  DeviceRole,
  DeviceStatus,
  InterfaceType,
  JobStatus,
  JobType,
  Prisma,
  ServerLifecycleStatus,
} from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretStorageUnavailableError } from '../../device-secret/device-secret.service';
import { CommissioningService } from '../commissioning.service';

const ZONE_ID = '550e8400-e29b-41d4-a716-446655440000';
const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const DEVICE_ID = 'device-uuid-1';
const SESSION_ID = 'scan-session-test';

const KNOWN_MAC = 'AA:BB:CC:DD:EE:01';
const NEW_MAC = 'AA:BB:CC:DD:EE:02';

type IfaceRow = { macAddress: string; device: { role: string | null; server: { lifecycleStatus: string } | null } };
type IpRow = { address: string; deviceRole: string | null; lifecycleStatus: string | null };

function makeService(overrides: {
  scanResults: Record<string, unknown>;
  interfaces?: IfaceRow[];
  ipRows?: IpRow[];
  plans?: Array<{ status: 'pending' | 'complete' | 'failed'; result?: unknown; error?: string }>;
}) {
  const plans = overrides.plans ?? [{ status: 'complete' as const, result: { scanResults: overrides.scanResults } }];
  const planIds = plans.map((_, i) => `p${i}`);
  const pollByPlan = new Map(planIds.map((id, i) => [id, plans[i]]));

  const redis = {
    get: vi.fn(async (key: string) =>
      key.startsWith('commissioning:scan-session:')
        ? JSON.stringify({ zoneId: ZONE_ID, planIds, subnets: planIds.map((_, i) => `10.0.${i}.0/24`) })
        : null,
    ),
    scan: vi.fn(async () => ['0', []] as [string, string[]]),
    pipeline: vi.fn(() => ({ hgetall: vi.fn(), exec: vi.fn(async () => []) })),
  };

  const bridgeNetworkScanService = {
    getScanResult: vi.fn(async (planId: string) => pollByPlan.get(planId)),
  };

  const prisma = {
    zone: {
      findFirst: vi.fn(async () => ({ id: ZONE_ID, organizationId: ORG_ID })),
      findUnique: vi.fn(async () => ({ id: ZONE_ID, organizationId: ORG_ID, deletedAt: null })),
    },
    interface: { findMany: vi.fn(async () => overrides.interfaces ?? []) },
    $queryRaw: vi.fn(async () => overrides.ipRows ?? []),
  };

  const contextService = { organizationId: ORG_ID, requirePermission: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const service = new CommissioningService(
    redis as never,
    bridgeNetworkScanService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
    contextService as never,
    eventEmitter as never,
    {} as never,
    {} as never,
    logger as never,
  );

  return { service, contextService };
}

function scanResults(devices: Record<string, { mac: string; ipmi: boolean; redfish: boolean }>) {
  return { results: { '10.0.0.0/24': { errored: false, results: devices } } };
}

describe('CommissioningService scan interpretation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes MACs already on a live commissioned (role!=null) device, returns the rest as Detected', async () => {
    const { service } = makeService({
      scanResults: scanResults({
        '10.0.0.10': { mac: KNOWN_MAC, ipmi: true, redfish: false },
        '10.0.0.11': { mac: NEW_MAC, ipmi: true, redfish: true },
      }),
      interfaces: [{ macAddress: KNOWN_MAC, device: { role: 'Server', server: { lifecycleStatus: 'INVENTORY' } } }],
    });

    const result = await service.pollScanSession(ZONE_ID, SESSION_ID);

    expect(result.status).toBe('complete');
    expect(result.result?.devices).toHaveLength(1);
    expect(result.result?.devices[0].bmcMac).toBe(NEW_MAC);
    expect(result.result?.devices[0].commissioningStatus).toBe('Detected');
  });

  it('dedups a device discovered in more than one scanned subnet into a single row', async () => {
    const dev = { '10.0.0.10': { mac: NEW_MAC, ipmi: true, redfish: false } };
    const { service } = makeService({
      scanResults: {},
      plans: [
        {
          status: 'complete',
          result: { scanResults: { results: { '10.0.0.0/24': { errored: false, results: dev } } } },
        },
        {
          status: 'complete',
          result: { scanResults: { results: { '10.0.1.0/24': { errored: false, results: dev } } } },
        },
      ],
    });

    const result = await service.pollScanSession(ZONE_ID, SESSION_ID);

    expect(result.status).toBe('complete');
    expect(result.result?.devices).toHaveLength(1);
    expect(result.result?.devices[0].bmcIp).toBe('10.0.0.10');
  });

  it('tags an in-progress (role=null) match with its lifecycle-derived commissioning status', async () => {
    const { service } = makeService({
      scanResults: scanResults({ '10.0.0.20': { mac: NEW_MAC, ipmi: true, redfish: false } }),
      interfaces: [{ macAddress: NEW_MAC, device: { role: null, server: { lifecycleStatus: 'PROVISIONING' } } }],
    });

    const result = await service.pollScanSession(ZONE_ID, SESSION_ID);

    expect(result.result?.devices).toHaveLength(1);
    expect(result.result?.devices[0].commissioningStatus).toBe('InProgress');
  });

  it('enforces the commissioning role before scanning', async () => {
    const { service, contextService } = makeService({ scanResults: scanResults({}) });
    await service.pollScanSession(ZONE_ID, SESSION_ID);
    expect(contextService.requirePermission).toHaveBeenCalled();
  });

  it('excludes MAC-less (L3) IPs already assigned to a live commissioned device', async () => {
    const { service } = makeService({
      scanResults: scanResults({
        '10.0.0.30': { mac: 'N/A', ipmi: true, redfish: false },
        '10.0.0.31': { mac: '', ipmi: true, redfish: false },
      }),
      ipRows: [{ address: '10.0.0.30', deviceRole: 'Server', lifecycleStatus: 'INVENTORY' }],
    });

    const result = await service.pollScanSession(ZONE_ID, SESSION_ID);

    expect(result.result?.devices).toHaveLength(1);
    expect(result.result?.devices[0].bmcIp).toBe('10.0.0.31');
  });

  it('flags a partial result when some subnets succeed and others fail (not a clean complete)', async () => {
    const { service } = makeService({
      scanResults: {},
      plans: [
        {
          status: 'complete',
          result: { scanResults: scanResults({ '10.0.0.10': { mac: NEW_MAC, ipmi: true, redfish: false } }) },
        },
        { status: 'failed', error: 'subnet 2 unreachable' },
      ],
    });

    const result = await service.pollScanSession(ZONE_ID, SESSION_ID);

    expect(result.status).toBe('complete');
    expect(result.result?.partial).toBe(true);
    expect(result.result?.subnetsTotal).toBe(2);
    expect(result.result?.subnetsFailed).toBe(1);
  });

  it('reports a non-partial result when every subnet scan succeeds', async () => {
    const { service } = makeService({
      scanResults: scanResults({ '10.0.0.10': { mac: NEW_MAC, ipmi: true, redfish: false } }),
    });

    const result = await service.pollScanSession(ZONE_ID, SESSION_ID);

    expect(result.result?.partial).toBe(false);
    expect(result.result?.subnetsFailed).toBe(0);
    expect(result.result?.subnetsTotal).toBe(1);
  });
});

function makeMutationService(
  overrides: {
    zone?: { id: string; organizationId: string } | null;
    commissioningDevice?: { id: string; zoneId: string | null } | null;
    serverLifecycle?: ServerLifecycleStatus | null;
    serverFound?: boolean;
    claimedCount?: number;
    deviceForRetry?: unknown;
    deviceCreateError?: unknown;
    interfaceRows?: Array<{ id: string }>;
    commissionDevice?: ReturnType<typeof vi.fn>;
    requirePermission?: ReturnType<typeof vi.fn>;
    queueJobs?: Array<Record<string, unknown>>;
    collectionJobs?: Array<Record<string, unknown>>;
    managementSubnets?: string[];
    progressDevices?: unknown[];
    zoneStatuses?: Array<{ isOnline: boolean }>;
  } = {},
) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
    device: {
      create: vi.fn(async () => {
        if (overrides.deviceCreateError) throw overrides.deviceCreateError;
        return { id: DEVICE_ID };
      }),
      update: vi.fn(async () => ({ id: DEVICE_ID })),
      updateMany: vi.fn(async () => ({ count: overrides.claimedCount ?? 1 })),
    },
    interface: {
      create: vi.fn(async () => ({ id: 'iface-1' })),
      findMany: vi.fn(async () => overrides.interfaceRows ?? [{ id: 'iface-1' }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    ipAddress: { updateMany: vi.fn(async () => ({ count: 1 })) },
    job: { updateMany: vi.fn(async () => ({ count: 1 })) },
    deployment: { updateMany: vi.fn(async () => ({ count: 0 })) },
    server: {
      findUnique: vi.fn(async () =>
        overrides.serverFound === false ? null : { lifecycleStatus: overrides.serverLifecycle ?? null },
      ),
      update: vi.fn(async () => ({ lifecycleStatus: 'INVENTORY' })),
    },
  };

  const commissionDevice = overrides.commissionDevice ?? vi.fn(async () => undefined);

  const prisma = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    $queryRaw: vi.fn(
      async (): Promise<Array<Record<string, string>>> =>
        (overrides.managementSubnets ?? []).map((prefix) => ({ prefix })),
    ),
    zone: {
      findUnique: vi.fn(async () =>
        overrides.zone === undefined
          ? { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null }
          : overrides.zone
            ? { ...overrides.zone, deletedAt: null }
            : null,
      ),
    },
    device: {
      findUnique: vi.fn(async (args: { where: Record<string, unknown> }) =>
        'role' in args.where
          ? overrides.commissioningDevice === undefined
            ? { id: DEVICE_ID, zoneId: ZONE_ID }
            : overrides.commissioningDevice
          : (overrides.deviceForRetry ?? null),
      ),
      update: vi.fn(async () => ({ id: DEVICE_ID })),
      findMany: vi.fn(async () => overrides.progressDevices ?? []),
    },
    zoneStatus: { findMany: vi.fn(async () => overrides.zoneStatuses ?? [{ isOnline: true }]) },
    job: {
      create: vi.fn(async () => ({ id: DEVICE_ID })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    server: {
      update: vi.fn(async () => ({ deviceId: DEVICE_ID, lifecycleStatus: ServerLifecycleStatus.PROVISIONING })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () =>
        overrides.serverFound === false ? null : { lifecycleStatus: overrides.serverLifecycle ?? null },
      ),
    },
  };

  const contextService = {
    organizationId: ORG_ID,
    userId: USER_ID,
    requirePermission: overrides.requirePermission ?? vi.fn(),
  };
  const eventEmitter = { emit: vi.fn() };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deviceSecretService = {
    write: vi.fn(async () => undefined),
    invalidateAll: vi.fn(async () => undefined),
    sealEphemeral: vi.fn(async (..._args: unknown[]) => ({ ephPub: 'eph', ciphertext: 'ct', tag: 'tag' })),
  };
  const deviceRecordPublisher = { writeForDevice: vi.fn(async () => true) };
  const bridgeCommissioningService = { commissionDevice };
  const bridgeEnrichmentService = {
    startEnrichment: vi.fn(async () => ({ success: true, planId: 'enrich-plan-id' })),
  };
  const bridgePowerControlService = {
    checkPowerStatus: vi.fn(async () => ({ id: 'bull-job-1' })),
    waitForJobCompletion: vi.fn(async () => 'completed' as string),
  };
  const bridgeQueueService = {
    getLifecycleQueue: vi.fn(() => ({ getJobs: vi.fn(async () => overrides.queueJobs ?? []) })),
    getCollectionQueue: vi.fn(() => ({ getJobs: vi.fn(async () => overrides.collectionJobs ?? []) })),
  };
  const redis = {
    scan: vi.fn(async () => ['0', []] as [string, string[]]),
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async (..._args: unknown[]) => 'OK'),
    del: vi.fn(async (..._args: unknown[]) => 1),
    pipeline: vi.fn(() => ({ get: vi.fn(), exec: vi.fn(async () => [] as unknown[]) })),
  };
  const bridgeNetworkScanService = { startScan: vi.fn(async () => ({ planId: 'scan-plan-1' })) };

  const service = new CommissioningService(
    redis as never,
    bridgeNetworkScanService as never,
    bridgeEnrichmentService as never,
    bridgeCommissioningService as never,
    bridgePowerControlService as never,
    bridgeQueueService as never,
    {
      resolve: vi.fn(async () => ({
        device: { id: DEVICE_ID, ipmiBootDeviceOverride: null },
        zoneId: ZONE_ID,
        bmcIp: '10.0.0.1',
        bmcSecret: { ephPub: 'eph', ciphertext: 'ct', tag: 'tag' },
      })),
    } as never,
    prisma as never,
    contextService as never,
    eventEmitter as never,
    deviceSecretService as never,
    deviceRecordPublisher as never,
    logger as never,
  );

  return {
    service,
    prisma,
    tx,
    contextService,
    eventEmitter,
    deviceSecretService,
    bridgeCommissioningService,
    bridgeEnrichmentService,
    bridgePowerControlService,
    bridgeNetworkScanService,
    bridgeQueueService,
    commissionDevice,
    logger,
    redis,
  };
}

describe('CommissioningService authorization & tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires the device:create permission before commissioning', async () => {
    const { service, contextService } = makeMutationService();
    await service.getCommissioningProgress(ZONE_ID).catch(() => undefined);
    expect(contextService.requirePermission).toHaveBeenCalledWith('device', 'create');
  });

  it('propagates the error when requirePermission throws (caller is not authorized)', async () => {
    const denied = new Error('forbidden');
    const requirePermission = vi.fn(() => {
      throw denied;
    });
    const { service, prisma } = makeMutationService({ requirePermission });
    await expect(service.acknowledgeCommissioning(ZONE_ID, DEVICE_ID)).rejects.toBe(denied);
    expect(prisma.zone.findUnique).not.toHaveBeenCalled();
    expect(prisma.device.findUnique).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the zone is not in the caller org (requireZone)', async () => {
    const { service } = makeMutationService({ zone: null });
    await expect(service.commissionDevices(ZONE_ID, [{ bmcMac: 'AA:BB:CC:DD:EE:01' } as never])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the commissioning device is missing (requireCommissioningDevice)', async () => {
    const { service, prisma } = makeMutationService({ commissioningDevice: null });
    await expect(service.acknowledgeCommissioning(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('CommissioningService commissionDevices (mutation/saga/secret)', () => {
  beforeEach(() => vi.clearAllMocks());

  const deviceInput = { bmcMac: 'AA:BB:CC:DD:EE:01', bmcUsername: 'admin', bmcPassword: 'secret' };

  it('creates device + seals creds in one transaction, then enqueues the commission saga post-commit', async () => {
    const { service, prisma, tx, deviceSecretService, commissionDevice } = makeMutationService();

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.device.create).toHaveBeenCalledTimes(1);
    expect(tx.interface.create).toHaveBeenCalledTimes(1);
    expect(deviceSecretService.write).toHaveBeenCalledTimes(1);
    expect(deviceSecretService.write).toHaveBeenCalledWith(
      DEVICE_ID,
      expect.anything(),
      expect.anything(),
      { user: 'admin', pass: 'secret' },
      USER_ID,
      expect.objectContaining({ skipIfLivePresent: true, tx }),
    );
    expect(prisma.job.create).toHaveBeenCalledTimes(1);
    expect(prisma.job.create).toHaveBeenCalledWith({
      data: {
        id: DEVICE_ID,
        jobType: JobType.Commission,
        status: JobStatus.Pending,
        device: { connect: { id: DEVICE_ID } },
        job: {
          zoneId: ZONE_ID,
          bmcMacAddress: 'AA:BB:CC:DD:EE:01',
          bmcIp: null,
        },
      },
    });
    expect(commissionDevice).toHaveBeenCalledTimes(1);
    expect(commissionDevice).toHaveBeenCalledWith(DEVICE_ID, DEVICE_ID, {}, ZONE_ID, undefined);
    expect(prisma.job.create.mock.invocationCallOrder[0]).toBeLessThan(commissionDevice.mock.invocationCallOrder[0]);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(1);
    expect(result.deviceIds).toEqual([DEVICE_ID]);
    expect(result.failedDevices).toBeUndefined();
  });

  const enrichedInput: CommissioningDeviceInput = {
    bmcMac: 'AA:BB:CC:DD:EE:01',
    bmcIp: '',
    bmcUsername: 'admin',
    bmcPassword: 'secret',
    nicMac: 'aa-bb-cc-dd-ee-01',
  };

  it('creates the eth0 row without a MAC when the BMC reports the NIC MAC', async () => {
    const { service, tx, logger } = makeMutationService();

    await service.commissionDevices(ZONE_ID, [enrichedInput]);

    expect(tx.interface.create).toHaveBeenCalledTimes(2);
    expect(tx.interface.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ name: 'IPMI', macAddress: 'AA:BB:CC:DD:EE:01' }) }),
    );
    expect(tx.interface.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ name: 'eth0', macAddress: null }) }),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('shares the NIC MAC'));
  });

  it('keeps the NIC MAC on eth0 when it differs from the BMC MAC', async () => {
    const { service, tx, logger } = makeMutationService();

    await service.commissionDevices(ZONE_ID, [{ ...enrichedInput, nicMac: 'aa:bb:cc:dd:ee:02' }]);

    expect(tx.interface.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:02' }) }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('shares the NIC MAC'));
  });

  it('translates the duplicate-name unique violation (P2002) into a generic duplication failure', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'Device_active_commissioning_name_unique' },
    });
    const { service, commissionDevice } = makeMutationService({ deviceCreateError: p2002 });

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);

    expect(commissionDevice).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.createdCount).toBe(0);
    expect(result.failedDevices?.[0].bmcMac).toBe('AA:BB:CC:DD:EE:01');
    expect(result.failedDevices?.[0].error).toContain('already exists');
  });

  it('recognizes the duplicate when P2002 reports meta.target as a column array', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['supplierId', 'zoneId', 'name'] },
    });
    const { service } = makeMutationService({ deviceCreateError: p2002 });

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);
    expect(result.failedDevices?.[0].error).toContain('already exists');
  });

  it('recognizes the duplicate when the raw partial index surfaces as a driver 23505 error', async () => {
    const driverErr = Object.assign(new Error('insert failed'), {
      cause: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "Device_active_commissioning_name_unique"',
      },
    });
    const { service } = makeMutationService({ deviceCreateError: driverErr });

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);
    expect(result.failedDevices?.[0].error).toContain('already exists');
  });

  it('does NOT mislabel a unique violation from another index (IP race) as a duplicate BMC', async () => {
    const ipP2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['address'] },
    });
    const { service } = makeMutationService({ deviceCreateError: ipP2002 });

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);
    expect(result.createdCount).toBe(0);
    expect(result.failedDevices?.[0].error).not.toContain('already exists');
  });

  it('soft-deletes the committed device and records a failure when the post-commit enqueue rejects', async () => {
    const enqueueErr = new Error('queue down');
    const commissionDevice = vi.fn(async () => {
      throw enqueueErr;
    });
    const { service, deviceSecretService, tx } = makeMutationService({ commissionDevice });

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);

    expect(deviceSecretService.invalidateAll).toHaveBeenCalledTimes(1);
    expect(deviceSecretService.invalidateAll).toHaveBeenCalledWith(
      DEVICE_ID,
      expect.objectContaining({ id: USER_ID }),
      'DEVICE_SOFT_DELETED',
      expect.anything(),
    );
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: DEVICE_ID,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Failed, error: 'queue down' },
    });
    expect(result.success).toBe(false);
    expect(result.createdCount).toBe(0);
    expect(result.failedDevices).toEqual([{ bmcMac: 'AA:BB:CC:DD:EE:01', error: 'queue down' }]);
  });

  it('logs loudly (does not swallow) when the post-enqueue-failure teardown also fails', async () => {
    const commissionDevice = vi.fn(async () => {
      throw new Error('queue down');
    });
    const { service, deviceSecretService, logger } = makeMutationService({ commissionDevice });
    deviceSecretService.invalidateAll.mockRejectedValueOnce(new Error('cleanup boom'));

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('needs manual cleanup'));
    expect(result.failedDevices).toEqual([{ bmcMac: 'AA:BB:CC:DD:EE:01', error: 'queue down' }]);
    expect(result.createdCount).toBe(0);
  });

  it('does not enqueue the saga when Job create fails', async () => {
    const { service, prisma, tx, commissionDevice, deviceSecretService } = makeMutationService();
    prisma.job.create.mockRejectedValueOnce(new Error('job write failed'));

    const result = await service.commissionDevices(ZONE_ID, [deviceInput as never]);

    expect(commissionDevice).not.toHaveBeenCalled();
    expect(tx.job.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: DEVICE_ID,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Failed, error: 'job write failed' },
    });
    expect(deviceSecretService.invalidateAll).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(0);
    expect(result.failedDevices?.[0].error).toMatch(/job write failed/);
  });
});

describe('CommissioningService acknowledgeCommissioning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a non-INVENTORY lifecycle with ConflictException', async () => {
    const { service, tx } = makeMutationService({ serverLifecycle: ServerLifecycleStatus.FAILED });
    await expect(service.acknowledgeCommissioning(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.device.updateMany).not.toHaveBeenCalled();
  });

  it('promotes an INVENTORY device to role=Server', async () => {
    const { service, tx } = makeMutationService({ serverLifecycle: ServerLifecycleStatus.INVENTORY });
    const result = await service.acknowledgeCommissioning(ZONE_ID, DEVICE_ID);
    expect(tx.device.updateMany).toHaveBeenCalledWith({
      where: { id: DEVICE_ID, role: null, deletedAt: null },
      data: { role: DeviceRole.Server, status: DeviceStatus.ACTIVE },
    });
    expect(result.success).toBe(true);
  });

  it('treats a zero claimed count as a concurrent-assignment ConflictException', async () => {
    const { service } = makeMutationService({
      serverLifecycle: ServerLifecycleStatus.INVENTORY,
      claimedCount: 0,
    });
    await expect(service.acknowledgeCommissioning(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CommissioningService retryCommissioning (reuse the row in place)', () => {
  beforeEach(() => vi.clearAllMocks());

  const retryInput = { bmcMac: 'AA:BB:CC:DD:EE:01', bmcUsername: 'admin', bmcPassword: 'secret' };

  it('reuses the failed device row in place (no soft-delete/recreate) and re-enqueues the commission saga', async () => {
    const { service, tx, deviceSecretService, commissionDevice } = makeMutationService({
      serverLifecycle: ServerLifecycleStatus.FAILED,
    });

    const result = await service.retryCommissioning(ZONE_ID, DEVICE_ID, retryInput as never);

    expect(deviceSecretService.invalidateAll).not.toHaveBeenCalled();
    expect(tx.device.create).not.toHaveBeenCalled();

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.deployment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { server: { deviceId: DEVICE_ID }, endDate: null } }),
    );
    expect(tx.device.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DEVICE_ID }, data: { status: DeviceStatus.PLANNED } }),
    );
    expect(tx.server.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: DEVICE_ID },
        data: { lifecycleStatus: ServerLifecycleStatus.INVENTORY },
      }),
    );
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: { id: DEVICE_ID, jobType: JobType.Commission },
      data: { status: JobStatus.Pending, error: null, lastCompletedStep: null },
    });

    expect(commissionDevice).toHaveBeenCalledTimes(1);
    expect(commissionDevice).toHaveBeenCalledWith(DEVICE_ID, DEVICE_ID, {}, ZONE_ID, undefined);
    expect(result.success).toBe(true);
  });

  it('rejects when the target device is not a live commissioning device (requireCommissioningDevice)', async () => {
    const { service } = makeMutationService({ commissioningDevice: null });
    await expect(service.retryCommissioning(ZONE_ID, DEVICE_ID, retryInput as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a non-FAILED device (the gate stops retry wiping qualified/in-flight work)', async () => {
    const { service, deviceSecretService, commissionDevice } = makeMutationService({
      serverLifecycle: ServerLifecycleStatus.INVENTORY,
    });
    await expect(service.retryCommissioning(ZONE_ID, DEVICE_ID, retryInput as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(deviceSecretService.invalidateAll).not.toHaveBeenCalled();
    expect(commissionDevice).not.toHaveBeenCalled();
  });
});

describe('CommissioningService retryCommissioningStep (in-place step retry)', () => {
  beforeEach(() => vi.clearAllMocks());

  const PLAN_ID = DEVICE_ID;

  function makePlanJson(overrides?: { stepStatus?: string; sagaName?: string }) {
    return JSON.stringify({
      plan_id: PLAN_ID,
      device_id: DEVICE_ID,
      job_class: overrides?.sagaName ?? 'commission',
      status: 'failed',
      created_at: Date.now() / 1000,
      steps: [
        { step_name: 'reboot_to_live', operation: 'Reboot to live', status: 'complete' },
        {
          step_name: 'deploy_os',
          operation: 'Deploy OS',
          status: overrides?.stepStatus ?? 'failed',
          error: 'disk not found',
        },
        { step_name: 'phone_home', operation: 'Wait for phone home', status: 'pending' },
      ],
    });
  }

  it('resets the failed step to pending, clears FAILED lifecycle, and re-enqueues the saga', async () => {
    const planKey = `${ZONE_ID}:bridge:jobs:plan:${PLAN_ID}`;
    const { service, redis, prisma, bridgeQueueService } = makeMutationService({
      serverLifecycle: ServerLifecycleStatus.FAILED,
    });
    redis.scan.mockResolvedValueOnce(['0', [planKey]]);
    redis.get.mockResolvedValueOnce(makePlanJson());
    (redis as Record<string, unknown>).eval = vi.fn(async () => 1);
    const mockJob = { data: { payload: { device_id: DEVICE_ID, bmc_ip: '10.0.0.1' } } };
    const mockQueue = { getJob: vi.fn(async () => mockJob), getJobs: vi.fn(async () => []) };
    bridgeQueueService.getLifecycleQueue.mockReturnValue(mockQueue);
    (bridgeQueueService as Record<string, unknown>).enqueueSagaJob = vi.fn(async () => ({ id: 'bull-1' }));

    const result = await service.retryCommissioningStep(ZONE_ID, DEVICE_ID);

    expect(result.success).toBe(true);
    expect((redis as Record<string, ReturnType<typeof vi.fn>>).eval).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      1,
      planKey,
    );
    expect(prisma.server.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { deviceId: DEVICE_ID } }));
    expect((bridgeQueueService as Record<string, ReturnType<typeof vi.fn>>).enqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'commission',
      PLAN_ID,
      expect.objectContaining({ device_id: DEVICE_ID }),
      DEVICE_ID,
    );
    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: PLAN_ID, jobType: JobType.Commission },
      data: { status: JobStatus.Pending, error: null, lastCompletedStep: null },
    });
  });

  it('rejects when the device is not in FAILED lifecycle state', async () => {
    const { service } = makeMutationService({ serverLifecycle: ServerLifecycleStatus.INVENTORY });
    await expect(service.retryCommissioningStep(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects when no saga plan is found in Redis', async () => {
    const { service, redis } = makeMutationService({ serverLifecycle: ServerLifecycleStatus.FAILED });
    redis.scan.mockResolvedValueOnce(['0', []]);

    await expect(service.retryCommissioningStep(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when the plan has no failed step (already reset)', async () => {
    const planKey = `${ZONE_ID}:bridge:jobs:plan:${PLAN_ID}`;
    const { service, redis, bridgeQueueService } = makeMutationService({
      serverLifecycle: ServerLifecycleStatus.FAILED,
    });
    redis.scan.mockResolvedValueOnce(['0', [planKey]]);
    redis.get.mockResolvedValueOnce(makePlanJson());
    (redis as Record<string, unknown>).eval = vi.fn(async () => 0);
    const mockQueue = { getJob: vi.fn(async () => null), getJobs: vi.fn(async () => []) };
    bridgeQueueService.getLifecycleQueue.mockReturnValue(mockQueue);

    await expect(service.retryCommissioningStep(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CommissioningService pollEnrichmentStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  const PLAN_ID = 'enrich-abc';

  it('returns pending when no plan exists yet but the started marker is still fresh', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(String(Date.now()));

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'pending', error: null });
  });

  it('returns expired when no plan exists and the started marker is gone (long-abandoned)', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'expired', error: null });
  });

  it('returns expired when no plan exists and the started marker is older than the grace window', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(String(Date.now() - 60 * 60 * 1000));

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'expired', error: null });
  });

  it('returns expired when the plan was cancelled', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(JSON.stringify({ plan_id: PLAN_ID, status: 'cancelled' }));

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'expired', error: null });
  });

  it('returns pending (not a 500) when the stored plan is corrupt non-JSON', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce('}not json{');

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'pending', error: null });
  });

  it('reports failed with the failed step error when a saga step failed', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        plan_id: PLAN_ID,
        status: 'running',
        steps: [
          { step_name: 'redfish_reliable_boot', status: 'complete' },
          { step_name: 'validate_ipmi', status: 'failed', error: 'IPMI credential validation failed' },
        ],
      }),
    );

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({
      status: 'failed',
      error: 'IPMI credential validation failed',
    });
  });

  it('reports complete when the plan completed with no failed step', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        plan_id: PLAN_ID,
        status: 'complete',
        steps: [{ step_name: 'validate_ipmi', status: 'complete' }],
      }),
    );

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'complete', error: null });
  });

  it('reads the zone-scoped plan key for the given plan id', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(null);

    await service.pollEnrichmentStatus(ZONE_ID, PLAN_ID);

    expect(redis.get).toHaveBeenCalledWith(`${ZONE_ID}:bridge:jobs:plan:${PLAN_ID}`);
  });

  it('returns expired when a running plan has been in flight past the grace window', async () => {
    const { service, redis } = makeMutationService();
    redis.get
      .mockResolvedValueOnce(JSON.stringify({ plan_id: PLAN_ID, status: 'running', steps: [] }))
      .mockResolvedValueOnce(String(Date.now() - 25 * 60 * 1_000));

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'expired', error: null });
  });

  it('keeps a running plan pending while still inside the grace window', async () => {
    const { service, redis } = makeMutationService();
    redis.get
      .mockResolvedValueOnce(JSON.stringify({ plan_id: PLAN_ID, status: 'running', steps: [] }))
      .mockResolvedValueOnce(String(Date.now()));

    await expect(service.pollEnrichmentStatus(ZONE_ID, PLAN_ID)).resolves.toEqual({ status: 'pending', error: null });
  });
});

describe('CommissioningService cancelEnrichment', () => {
  beforeEach(() => vi.clearAllMocks());

  const PLAN_ID = 'enrich-cancel-1';

  it('sweeps BOTH the lifecycle and collection queues for the enrich plan id', async () => {
    const lifecycleJob = {
      id: 'life-1',
      data: { device_id: PLAN_ID, saga_name: 'enrich_via_pxe' },
      getState: vi.fn(async () => 'delayed'),
      discard: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const collectionJob = {
      id: 'coll-1',
      data: { device_id: PLAN_ID, plan_id: 'inner-uuid', job_id: PLAN_ID },
      getState: vi.fn(async () => 'delayed'),
      discard: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const { service, bridgeQueueService } = makeMutationService({
      queueJobs: [lifecycleJob],
      collectionJobs: [collectionJob],
    });

    const result = await service.cancelEnrichment(ZONE_ID, PLAN_ID);

    expect(bridgeQueueService.getLifecycleQueue).toHaveBeenCalledWith(ZONE_ID);
    expect(bridgeQueueService.getCollectionQueue).toHaveBeenCalledWith(ZONE_ID);
    expect(lifecycleJob.remove).toHaveBeenCalledTimes(1);
    expect(collectionJob.remove).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('discards (not removes) an ACTIVE collection job it cannot remove', async () => {
    const collectionJob = {
      id: 'coll-active',
      data: { plan_id: PLAN_ID },
      getState: vi.fn(async () => 'active'),
      discard: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const { service } = makeMutationService({ collectionJobs: [collectionJob] });

    await service.cancelEnrichment(ZONE_ID, PLAN_ID);

    expect(collectionJob.discard).toHaveBeenCalledTimes(1);
    expect(collectionJob.remove).not.toHaveBeenCalled();
  });

  it('leaves unrelated jobs (different plan id) untouched', async () => {
    const otherJob = {
      id: 'other',
      data: { device_id: 'some-other-device', plan_id: 'unrelated' },
      getState: vi.fn(async () => 'delayed'),
      discard: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const { service } = makeMutationService({ queueJobs: [otherJob], collectionJobs: [otherJob] });

    await service.cancelEnrichment(ZONE_ID, PLAN_ID);

    expect(otherJob.remove).not.toHaveBeenCalled();
    expect(otherJob.discard).not.toHaveBeenCalled();
  });

  it('marks a live Redis enrich plan cancelled with KEEPTTL and drops the started marker', async () => {
    const { service, redis } = makeMutationService();
    redis.get.mockResolvedValueOnce(JSON.stringify({ plan_id: PLAN_ID, status: 'running', steps: [] }));

    await service.cancelEnrichment(ZONE_ID, PLAN_ID);

    const setCall = redis.set.mock.calls.find(([key]) => key === `${ZONE_ID}:bridge:jobs:plan:${PLAN_ID}`);
    expect(setCall).toBeDefined();
    expect(setCall?.[1]).toContain('"status":"cancelled"');
    expect(setCall?.[2]).toBe('KEEPTTL');
    expect(redis.del).toHaveBeenCalledWith(`commissioning:enrich-started:${ZONE_ID}:${PLAN_ID}`);
  });

  it('rejects a non-enrich plan id without touching redis (cannot cancel a real device saga)', async () => {
    const { service, redis } = makeMutationService();

    await expect(service.cancelEnrichment(ZONE_ID, 'a-real-device-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});

describe('CommissioningService softDeleteCommissioningDevice (via cancelCommissioning)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invalidates secrets inside the tx and soft-deletes interfaces + IPs', async () => {
    const { service, prisma, tx, deviceSecretService, eventEmitter } = makeMutationService({
      interfaceRows: [{ id: 'iface-1' }, { id: 'iface-2' }],
    });

    const result = await service.cancelCommissioning(ZONE_ID, DEVICE_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.ipAddress.updateMany).toHaveBeenCalledWith({
      where: { interfaceId: { in: ['iface-1', 'iface-2'] }, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.interface.updateMany).toHaveBeenCalledWith({
      where: { deviceId: DEVICE_ID, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.device.updateMany).toHaveBeenCalledWith({
      where: { id: DEVICE_ID, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(deviceSecretService.invalidateAll).toHaveBeenCalledWith(
      DEVICE_ID,
      expect.objectContaining({ id: USER_ID }),
      'DEVICE_SOFT_DELETED',
      tx,
    );
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: DEVICE_ID,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Failed, error: 'Commissioning discarded' },
    });
    expect(eventEmitter.emit).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('rejects cancelling a qualified (INVENTORY) device and tears nothing down', async () => {
    const { service, prisma, eventEmitter, deviceSecretService } = makeMutationService({
      serverLifecycle: ServerLifecycleStatus.INVENTORY,
    });

    await expect(service.cancelCommissioning(ZONE_ID, DEVICE_ID)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(deviceSecretService.invalidateAll).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('cancels a FAILED device (a terminal-but-not-qualified state stays cancellable)', async () => {
    const { service, eventEmitter } = makeMutationService({ serverLifecycle: ServerLifecycleStatus.FAILED });
    const result = await service.cancelCommissioning(ZONE_ID, DEVICE_ID);
    expect(result.success).toBe(true);
    expect(eventEmitter.emit).toHaveBeenCalled();
  });

  it('removes a waiting bridge job but discards (cannot remove) an active one', async () => {
    const waiting = {
      id: 'job-waiting',
      data: { device_id: DEVICE_ID },
      getState: vi.fn(async () => 'waiting'),
      remove: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const active = {
      id: 'job-active',
      data: { device_id: DEVICE_ID },
      getState: vi.fn(async () => 'active'),
      remove: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const other = {
      id: 'job-other',
      data: { device_id: 'some-other-device' },
      getState: vi.fn(async () => 'waiting'),
      remove: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const { service } = makeMutationService({ queueJobs: [waiting, active, other] });

    await service.cancelCommissioning(ZONE_ID, DEVICE_ID);

    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(waiting.discard).not.toHaveBeenCalled();
    expect(active.discard).toHaveBeenCalledTimes(1);
    expect(active.remove).not.toHaveBeenCalled();
    expect(other.remove).not.toHaveBeenCalled();
    expect(other.discard).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op when the device is already soft-deleted', async () => {
    const { service, tx, deviceSecretService, eventEmitter } = makeMutationService({ claimedCount: 0 });

    const result = await service.cancelCommissioning(ZONE_ID, DEVICE_ID);

    expect(tx.device.updateMany).toHaveBeenCalledWith({
      where: { id: DEVICE_ID, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.job.updateMany).not.toHaveBeenCalled();
    expect(deviceSecretService.invalidateAll).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

describe('CommissioningService enrichDevice', () => {
  beforeEach(() => vi.clearAllMocks());

  const req = { bmcIp: '10.0.0.5', bmcUsername: 'admin', bmcPassword: 'secret' };

  it('seals creds ephemerally under an enrich plan id and dispatches enrich_via_pxe', async () => {
    const { service, deviceSecretService, bridgeEnrichmentService, redis } = makeMutationService();

    const result = await service.enrichDevice(ZONE_ID, req);

    expect(deviceSecretService.sealEphemeral).toHaveBeenCalledWith(
      ZONE_ID,
      expect.stringMatching(/^enrich-/),
      expect.anything(),
      expect.anything(),
      { user: 'admin', pass: 'secret' },
      expect.objectContaining({ id: USER_ID }),
    );
    const planId = deviceSecretService.sealEphemeral.mock.calls[0][1];
    expect(redis.set).toHaveBeenCalledWith(
      `commissioning:enrich-started:${ZONE_ID}:${planId}`,
      expect.stringMatching(/^\d+$/),
      'PX',
      20 * 60 * 1_000,
    );
    expect(bridgeEnrichmentService.startEnrichment).toHaveBeenCalledWith(ZONE_ID, req.bmcIp, expect.anything(), planId);
    expect(result).toEqual({ success: true, planId: 'enrich-plan-id' });
  });

  it('throws ServiceUnavailableException when the zone is not enrolled (seal fails)', async () => {
    const { service, deviceSecretService, bridgeEnrichmentService } = makeMutationService();
    deviceSecretService.sealEphemeral.mockRejectedValueOnce(new SecretStorageUnavailableError('zone not enrolled'));

    await expect(service.enrichDevice(ZONE_ID, req)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(bridgeEnrichmentService.startEnrichment).not.toHaveBeenCalled();
  });

  it('rethrows a non-secret error from the bridge enqueue', async () => {
    const { service, bridgeEnrichmentService } = makeMutationService();
    bridgeEnrichmentService.startEnrichment.mockRejectedValueOnce(new Error('queue down'));

    await expect(service.enrichDevice(ZONE_ID, req)).rejects.toThrow('queue down');
  });
});

describe('CommissioningService validateCommissioning', () => {
  beforeEach(() => vi.clearAllMocks());

  const validInput = { bmcMac: 'AA:BB:CC:DD:EE:01', bmcIp: '10.0.0.5', bmcUsername: 'admin', bmcPassword: 'secret' };

  it('throws BadRequestException on an empty device list', async () => {
    const { service } = makeMutationService();
    await expect(service.validateCommissioning(ZONE_ID, [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports missing credentials without sealing or dispatching', async () => {
    const { service, deviceSecretService, bridgePowerControlService } = makeMutationService();
    const result = await service.validateCommissioning(ZONE_ID, [
      { bmcMac: 'AA:BB:CC:DD:EE:01', bmcIp: '10.0.0.5' } as never,
    ]);
    expect(result.ipmiTestResults[0].success).toBe(false);
    expect(result.ipmiTestResults[0].message).toContain('credentials missing');
    expect(deviceSecretService.sealEphemeral).not.toHaveBeenCalled();
    expect(bridgePowerControlService.checkPowerStatus).not.toHaveBeenCalled();
  });

  it('reports a missing BMC IP', async () => {
    const { service, bridgePowerControlService } = makeMutationService();
    const result = await service.validateCommissioning(ZONE_ID, [
      { bmcMac: 'AA:BB:CC:DD:EE:01', bmcUsername: 'admin', bmcPassword: 'secret' } as never,
    ]);
    expect(result.ipmiTestResults[0].success).toBe(false);
    expect(result.ipmiTestResults[0].message).toContain('IP address is required');
    expect(bridgePowerControlService.checkPowerStatus).not.toHaveBeenCalled();
  });

  it('passes when the power_status job completes', async () => {
    const { service, deviceSecretService, bridgePowerControlService } = makeMutationService();
    const result = await service.validateCommissioning(ZONE_ID, [validInput as never]);
    expect(deviceSecretService.sealEphemeral).toHaveBeenCalledOnce();
    expect(bridgePowerControlService.checkPowerStatus).toHaveBeenCalledWith(
      ZONE_ID,
      validInput.bmcIp,
      expect.anything(),
      expect.any(String),
    );
    expect(result.ipmiTestResults[0].success).toBe(true);
    expect(result.successfulTests).toBe(1);
  });

  it('fails when the power_status job does not complete', async () => {
    const { service, bridgePowerControlService } = makeMutationService();
    bridgePowerControlService.waitForJobCompletion.mockResolvedValueOnce('failed');
    const result = await service.validateCommissioning(ZONE_ID, [validInput as never]);
    expect(result.ipmiTestResults[0].success).toBe(false);
    expect(result.ipmiTestResults[0].message).toContain('IPMI validation failed');
  });

  it('reports a seal failure (zone not enrolled) as a validation failure, not a throw', async () => {
    const { service, deviceSecretService, bridgePowerControlService } = makeMutationService();
    deviceSecretService.sealEphemeral.mockRejectedValueOnce(new SecretStorageUnavailableError('not enrolled'));
    const result = await service.validateCommissioning(ZONE_ID, [validInput as never]);
    expect(result.ipmiTestResults[0].success).toBe(false);
    expect(result.ipmiTestResults[0].message).toContain('Cannot validate');
    expect(bridgePowerControlService.checkPowerStatus).not.toHaveBeenCalled();
  });
});

describe('CommissioningService scanZoneManagementSubnets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fans out one scan per MANAGEMENT subnet and stores the scan session', async () => {
    const { service, bridgeNetworkScanService, redis } = makeMutationService({
      managementSubnets: ['10.0.0.0/24', '10.0.1.0/24'],
    });

    const result = await service.scanZoneManagementSubnets(ZONE_ID);

    expect(bridgeNetworkScanService.startScan).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledOnce();
    expect(result.subnets).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
    expect(result.sessionId).toMatch(/^scan-session-/);
  });

  it('throws BadRequestException when the zone has no MANAGEMENT subnets', async () => {
    const { service, bridgeNetworkScanService } = makeMutationService({ managementSubnets: [] });
    await expect(service.scanZoneManagementSubnets(ZONE_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(bridgeNetworkScanService.startScan).not.toHaveBeenCalled();
  });

  it('normalizes the supplied subnet override and scans it without querying zone prefixes', async () => {
    const { service, prisma, bridgeNetworkScanService } = makeMutationService();
    prisma.$queryRaw.mockResolvedValueOnce([{ normalized: '192.168.1.0/24' }]);

    const result = await service.scanZoneManagementSubnets(ZONE_ID, ['192.168.1.2/24']);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(bridgeNetworkScanService.startScan).toHaveBeenCalledWith(ZONE_ID, '192.168.1.0/24');
    expect(result.subnets).toEqual(['192.168.1.0/24']);
  });
});

describe('CommissioningService getCommissioningProgress', () => {
  beforeEach(() => vi.clearAllMocks());

  const makeProgressDevice = (over: Record<string, unknown> = {}) => ({
    id: DEVICE_ID,
    status: DeviceStatus.PLANNED,
    zoneId: ZONE_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    systemSerial: 'SN-1',
    server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
    interfaces: [
      {
        type: InterfaceType.IPMI_BMC,
        macAddress: 'aa:bb:cc:dd:ee:01',
        mgmtOnly: true,
        ipAddresses: [{ address: '10.0.0.5/24' }],
      },
      {
        type: InterfaceType.ETHERNET_1G,
        macAddress: 'aa:bb:cc:dd:ee:02',
        mgmtOnly: false,
        ipAddresses: [{ address: '10.0.1.5/24' }],
      },
    ],
    ...over,
  });

  it('derives bmc/nic identifiers (mask stripped) and reflects an online zone', async () => {
    const { service } = makeMutationService({ progressDevices: [makeProgressDevice()] });
    const result = await service.getCommissioningProgress(ZONE_ID);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(item.bmcMac).toBe('aa:bb:cc:dd:ee:01');
    expect(item.bmcIp).toBe('10.0.0.5');
    expect(item.nicMac).toBe('aa:bb:cc:dd:ee:02');
    expect(item.nicIp).toBe('10.0.1.5');
    expect(item.zoneOnline).toBe(true);
    expect(item.lifecycleFailed).toBe(false);
    expect(item.lifecycleQualified).toBe(false);
    expect(item.sagaSteps).toEqual([]);
  });

  it('marks the zone offline when no ZoneStatus row is online', async () => {
    const { service } = makeMutationService({
      progressDevices: [makeProgressDevice()],
      zoneStatuses: [{ isOnline: false }],
    });
    const result = await service.getCommissioningProgress(ZONE_ID);
    expect(result.data[0].zoneOnline).toBe(false);
  });

  it('flags FAILED and INVENTORY lifecycle states', async () => {
    const failed = makeProgressDevice({ id: 'dev-failed', server: { lifecycleStatus: ServerLifecycleStatus.FAILED } });
    const qualified = makeProgressDevice({
      id: 'dev-inv',
      server: { lifecycleStatus: ServerLifecycleStatus.INVENTORY },
    });
    const { service } = makeMutationService({ progressDevices: [failed, qualified] });
    const result = await service.getCommissioningProgress(ZONE_ID);
    expect(result.data.find((d) => d.deviceId === 'dev-failed')?.lifecycleFailed).toBe(true);
    expect(result.data.find((d) => d.deviceId === 'dev-inv')?.lifecycleQualified).toBe(true);
  });

  it('treats a device with no Server row (pre-qualify) as neither failed nor qualified', async () => {
    const { service } = makeMutationService({ progressDevices: [makeProgressDevice({ server: null })] });
    const result = await service.getCommissioningProgress(ZONE_ID);
    expect(result.data[0].lifecycleFailed).toBe(false);
    expect(result.data[0].lifecycleQualified).toBe(false);
  });

  it('returns an empty list when no commissioning devices exist', async () => {
    const { service } = makeMutationService({ progressDevices: [] });
    const result = await service.getCommissioningProgress(ZONE_ID);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});
