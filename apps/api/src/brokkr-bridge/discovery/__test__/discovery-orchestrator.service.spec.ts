import type { Device } from '@repo/database';
import { TeeCapability } from '@repo/database';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CollectorRegistry } from '../collectors/collector.registry';
import type { CollectorHandler, DeviceMutation } from '../collectors/collector.types';
import { ComposerRegistry } from '../composers/composer.registry';
import type { Composer } from '../composers/composer.types';
import type { DiscoveryEventsService } from '../discovery-events.service';
import { DiscoveryOrchestratorService } from '../discovery-orchestrator.service';
import type { DiscoveryS3UploadService } from '../discovery-s3-upload.service';
import type { DiscoveryRunIssueRecorder } from '../discovery-run-issue.recorder';
import { DiscoveryEvent } from '../discovery.events';

const fakeLogger: any = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const fakeDevice = { id: 'dev-uuid-1', teeEnabled: false } as unknown as Device;

interface Harness {
  orchestrator: DiscoveryOrchestratorService;
  prisma: {
    device: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    discoveryRun: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    discoveryRunIssue: { create: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  s3: { uploadCollectorPayload: ReturnType<typeof vi.fn> };
  events: DiscoveryEventsService;
  eventEmit: ReturnType<typeof vi.fn>;
  recorder: DiscoveryRunIssueRecorder;
  recorderRecord: ReturnType<typeof vi.fn>;
  registry: CollectorRegistry;
  composerRegistry: ComposerRegistry;
}

const makeHarness = ({
  deviceFound = true,
  transactionThrows = false,
  serverUpdateCount = 1,
  issuesBySeverity = [],
}: {
  deviceFound?: boolean;
  transactionThrows?: boolean;
  serverUpdateCount?: number;
  issuesBySeverity?: Array<{ severity: 'INFO' | 'WARN' | 'ERROR'; _count: { _all: number } }>;
} = {}): Harness => {
  const deviceUpdate = vi.fn().mockResolvedValue(fakeDevice);
  const prisma = {
    device: {
      findUnique: vi.fn().mockResolvedValue(deviceFound ? fakeDevice : null),
      update: deviceUpdate,
    },
    discoveryRun: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    discoveryRunIssue: {
      create: vi.fn().mockResolvedValue({}),
      groupBy: vi.fn().mockResolvedValue(issuesBySeverity),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      if (transactionThrows) throw new Error('commit failed');
      const tx = {
        device: { update: deviceUpdate, findUnique: vi.fn().mockResolvedValue(null) },
        server: {
          updateMany: vi.fn().mockResolvedValue({ count: serverUpdateCount }),
        },
        gpu: { upsert: vi.fn() },
        cpu: { upsert: vi.fn() },
        storageDrive: { upsert: vi.fn() },
        memoryConfig: { upsert: vi.fn() },
        interface: { upsert: vi.fn() },
        deviceFirmware: { upsert: vi.fn() },
        pciDevice: { upsert: vi.fn() },
        uefiBootEntry: { upsert: vi.fn() },
        nvlinkEdge: { upsert: vi.fn() },
        deviceSolConfig: { upsert: vi.fn() },
      };
      return cb(tx);
    }),
  };

  const s3 = { uploadCollectorPayload: vi.fn().mockResolvedValue(true) };
  const eventEmit = vi.fn();
  const events = { emit: eventEmit } as unknown as DiscoveryEventsService;
  const recorderRecord = vi.fn().mockResolvedValue(undefined);
  const recorder = {
    record: recorderRecord,
    recordMany: vi.fn(async (xs: unknown[]) => {
      for (const x of xs) await recorderRecord(x);
    }),
  } as unknown as DiscoveryRunIssueRecorder;

  const registry = new CollectorRegistry();
  const composerRegistry = new ComposerRegistry();

  const orchestrator = new DiscoveryOrchestratorService(
    prisma as unknown as PrismaClient,
    registry,
    composerRegistry,
    s3 as unknown as DiscoveryS3UploadService,
    events,
    recorder,
    fakeLogger,
  );

  return { orchestrator, prisma, s3, events, eventEmit, recorder, recorderRecord, registry, composerRegistry };
};

const okHandler = (
  name: string,
  deviceUpdate?: Partial<DeviceMutation['deviceUpdate']>,
): CollectorHandler<unknown> => ({
  name: name as any,

  schema: z.unknown() as any,
  handle: vi.fn(async () => ({ deviceUpdate })),
});

describe('DiscoveryOrchestratorService', () => {
  beforeEach(() => {
    fakeLogger.log.mockClear();
    fakeLogger.warn.mockClear();
    fakeLogger.error.mockClear();
  });

  it('returns early with a warning when the Device does not exist', async () => {
    const { orchestrator, prisma } = makeHarness({ deviceFound: false });

    await orchestrator.runDiscovery({
      deviceId: 'missing-uuid',
      zonePrefix: 'zp',
      jobId: 'job-1',
      bundle: { architecture: { machine: 'x86_64' } },
      collectorCount: 1,
    });

    expect(prisma.discoveryRun.create).not.toHaveBeenCalled();
    expect(fakeLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/unknown device id/i), 'job-1');
  });

  it('creates a DiscoveryRun row, uploads every collector to S3, and emits RunStarted', async () => {
    const { orchestrator, prisma, s3, eventEmit, registry } = makeHarness();
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'job-1',
      bundle: { architecture: { machine: 'x86_64' }, unknown_collector: { foo: 1 } },
      collectorCount: 2,
    });

    expect(prisma.discoveryRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deviceId: 'dev-uuid-1',
          status: 'STARTED',
          jobId: 'job-1',
          zonePrefix: 'zp',
          collectorsExpected: 2,
          collectorsReceived: 2,
        }),
      }),
    );
    expect(s3.uploadCollectorPayload).toHaveBeenCalledTimes(2);
    expect(eventEmit).toHaveBeenCalledWith(DiscoveryEvent.RunStarted, expect.any(Object));
  });

  it('marks unknown collectors NO_HANDLER but still uploads them', async () => {
    const { orchestrator, s3, recorderRecord } = makeHarness();

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { something_weird: { x: 1 } },
      collectorCount: 1,
    });

    expect(s3.uploadCollectorPayload).toHaveBeenCalledWith('dev-uuid-1', expect.any(String), 'something_weird', {
      x: 1,
    });
    expect(recorderRecord).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NO_HANDLER', collector: 'something_weird' }),
    );
  });

  it('finalises SUCCEEDED when all handlers apply cleanly and no issues', async () => {
    const { orchestrator, prisma, eventEmit, registry } = makeHarness();
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: 'x86_64' } },
      collectorCount: 1,
    });

    expect(prisma.discoveryRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
    );
    expect(eventEmit).toHaveBeenCalledWith(DiscoveryEvent.RunCompleted, expect.any(Object));
  });

  it('finalises PARTIAL when at least one collector is skipped', async () => {
    const { orchestrator, prisma, registry } = makeHarness();
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: 'x86_64' }, unhandled: {} },
      collectorCount: 2,
    });

    const updateCalls = prisma.discoveryRun.update.mock.calls;
    expect(updateCalls[updateCalls.length - 1][0]).toMatchObject({ data: { status: 'PARTIAL' } });
  });

  it('records HANDLER_THREW and emits CollectorFailed when a handler throws', async () => {
    const { orchestrator, recorderRecord, eventEmit, registry } = makeHarness();
    const throwing: CollectorHandler<unknown> = {
      name: 'architecture',

      schema: z.unknown() as any,
      handle: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    registry.register(throwing);

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: {} },
      collectorCount: 1,
    });

    expect(recorderRecord).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HANDLER_THREW', severity: 'ERROR', collector: 'architecture' }),
    );
    expect(eventEmit).toHaveBeenCalledWith(
      DiscoveryEvent.CollectorFailed,
      expect.objectContaining({ collector: 'architecture' }),
    );
  });

  it('records PARSE_FAILED and emits CollectorInvalid when schema rejects', async () => {
    const { orchestrator, recorderRecord, eventEmit, registry } = makeHarness();
    registry.register({
      name: 'architecture',

      schema: z.object({ machine: z.string().min(1) }) as any,
      handle: vi.fn(),
    });

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: '' } },
      collectorCount: 1,
    });

    expect(recorderRecord).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PARSE_FAILED', severity: 'WARN', collector: 'architecture' }),
    );
    expect(eventEmit).toHaveBeenCalledWith(
      DiscoveryEvent.CollectorInvalid,
      expect.objectContaining({ collector: 'architecture' }),
    );
  });

  it('runs composers after handlers and emits ComposerApplied', async () => {
    const { orchestrator, eventEmit, registry, composerRegistry } = makeHarness();
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));
    const composer: Composer = {
      name: 'tee',
      compose: vi.fn(async () => ({ serverUpdate: { teeCapable: TeeCapability.TRUE } })),
    };
    composerRegistry.register(composer);

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: 'x86_64' } },
      collectorCount: 1,
    });

    expect(composer.compose).toHaveBeenCalled();
    expect(eventEmit).toHaveBeenCalledWith(
      DiscoveryEvent.ComposerApplied,
      expect.objectContaining({ composer: 'tee' }),
    );
  });

  it('records a SERVER_ROW_ABSENT issue when serverUpdate is skipped (no Server row)', async () => {
    const { orchestrator, recorderRecord, registry, composerRegistry } = makeHarness({ serverUpdateCount: 0 });
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));
    composerRegistry.register({
      name: 'tee',
      compose: vi.fn(async () => ({ serverUpdate: { teeCapable: TeeCapability.TRUE } })),
    });

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: 'x86_64' } },
      collectorCount: 1,
    });

    expect(recorderRecord).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'COMMIT', code: 'SERVER_ROW_ABSENT', severity: 'INFO' }),
    );
  });

  it('finalises SUCCEEDED when the only recorded issues are INFO severity', async () => {
    const { orchestrator, prisma, eventEmit, registry } = makeHarness({
      issuesBySeverity: [{ severity: 'INFO', _count: { _all: 2 } }],
    });
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: 'x86_64' } },
      collectorCount: 1,
    });

    const updateCalls = prisma.discoveryRun.update.mock.calls;
    expect(updateCalls[updateCalls.length - 1][0]).toMatchObject({ data: { status: 'SUCCEEDED' } });
    expect(eventEmit).toHaveBeenCalledWith(DiscoveryEvent.RunCompleted, expect.objectContaining({ issueCount: 2 }));
  });

  it('finalises PARTIAL when a WARN/ERROR issue exists with no skipped collectors', async () => {
    const { orchestrator, prisma, registry } = makeHarness({
      issuesBySeverity: [
        { severity: 'INFO', _count: { _all: 1 } },
        { severity: 'ERROR', _count: { _all: 1 } },
      ],
    });
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));

    await orchestrator.runDiscovery({
      deviceId: 'dev-uuid-1',
      zonePrefix: 'zp',
      jobId: 'j',
      bundle: { architecture: { machine: 'x86_64' } },
      collectorCount: 1,
    });

    const updateCalls = prisma.discoveryRun.update.mock.calls;
    expect(updateCalls[updateCalls.length - 1][0]).toMatchObject({ data: { status: 'PARTIAL' } });
  });

  it('finalises FAILED + emits RunFailed when the commit transaction throws', async () => {
    const { orchestrator, prisma, eventEmit, recorderRecord, registry } = makeHarness({
      transactionThrows: true,
    });
    registry.register(okHandler('architecture', { architecture: 'x86_64' }));

    await expect(
      orchestrator.runDiscovery({
        deviceId: 'dev-uuid-1',
        zonePrefix: 'zp',
        jobId: 'j',
        bundle: { architecture: { machine: 'x86_64' } },
        collectorCount: 1,
      }),
    ).rejects.toThrow(/commit failed/);

    expect(recorderRecord).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'COMMIT_FAILED', severity: 'ERROR', phase: 'COMMIT' }),
    );
    const updateCalls = prisma.discoveryRun.update.mock.calls;
    expect(updateCalls[updateCalls.length - 1][0]).toMatchObject({ data: { status: 'FAILED' } });
    expect(eventEmit).toHaveBeenCalledWith(DiscoveryEvent.RunFailed, expect.objectContaining({ phase: 'commit' }));
  });
});
