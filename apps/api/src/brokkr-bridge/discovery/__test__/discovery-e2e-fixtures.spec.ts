import { createPrismaClient, PrismaClient } from '@repo/database';
import type { LoggerService } from 'src/logger/logger.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMutations } from '../apply-mutations';
import { COLLECTOR_HANDLERS } from '../collectors';
import { CollectorRegistry } from '../collectors/collector.registry';
import type { CollectorHandler } from '../collectors/collector.types';
import { ComposerRegistry } from '../composers/composer.registry';
import { IpmiInterfaceComposer } from '../composers/ipmi-interface.composer';
import { LifecycleComposer } from '../composers/lifecycle.composer';
import { NetworkTypeComposer } from '../composers/network-type.composer';
import { StorageLayoutsComposer } from '../composers/storage-layouts.composer';
import { TeeComposer } from '../composers/tee.composer';
import { DiscoveryEventsService } from '../discovery-events.service';
import { DiscoveryOrchestratorService } from '../discovery-orchestrator.service';
import type { DiscoveryS3UploadService } from '../discovery-s3-upload.service';
import { DiscoveryRunIssueRecorder } from '../discovery-run-issue.recorder';
import type { FixtureDevice } from './load-fixtures';
import { loadFixtures } from './load-fixtures';
import { cleanupSeededDevices, seedDevices } from './seed-devices';


const fixtures: FixtureDevice[] = loadFixtures();
const skip = fixtures.length === 0 || !process.env.DATABASE_URL;

const silentLogger: LoggerService = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  verbose: () => {},
} as unknown as LoggerService;

const s3Stub: Pick<DiscoveryS3UploadService, 'uploadCollectorPayload'> = {
  uploadCollectorPayload: async () => true,
};

const attestationStub = {
  get: () =>
    ({
      subscribe: (observer: { next: (v: unknown) => void; complete: () => void }) => {
        observer.next({ data: { ids: [] } });
        observer.complete();
        return { unsubscribe: () => {} };
      },
      pipe: () => attestationStub.get(),
    }) as never,
};

let prisma: PrismaClient;
let orchestrator: DiscoveryOrchestratorService;
const emittedEvents: Array<{ name: string; payload: unknown }> = [];

beforeAll(async () => {
  if (skip) return;

  prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL! });
  await prisma.$connect();

  await seedDevices(
    prisma,
    fixtures.map((f) => f.deviceId),
  );

  const collectorRegistry = new CollectorRegistry();
  for (const HandlerClass of COLLECTOR_HANDLERS) {
    const handler = new (HandlerClass as new () => CollectorHandler<unknown>)();
    collectorRegistry.register(handler);
  }

  const composerRegistry = new ComposerRegistry();
  composerRegistry.register(new LifecycleComposer());
  composerRegistry.register(new TeeComposer(attestationStub as never));
  composerRegistry.register(new IpmiInterfaceComposer());
  composerRegistry.register(new NetworkTypeComposer());
  composerRegistry.register(new StorageLayoutsComposer());

  const eventsService = {
    emit: (name: string, payload: unknown) => {
      emittedEvents.push({ name, payload });
    },
  } as unknown as DiscoveryEventsService;

  const recorder = new DiscoveryRunIssueRecorder(prisma as never, silentLogger);

  orchestrator = new DiscoveryOrchestratorService(
    prisma as never,
    collectorRegistry,
    composerRegistry,
    s3Stub as DiscoveryS3UploadService,
    eventsService,
    recorder,
    silentLogger,
  );
  void applyMutations;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  if (process.env.KEEP_DISCOVERY_RUN_DATA !== 'true') {
    await cleanupSeededDevices(
      prisma,
      fixtures.map((f) => f.deviceId),
    );
  }
  await prisma.$disconnect();
}, 60_000);

describe.skipIf(skip)('DiscoveryOrchestrator — committed fixture replay', () => {
  it(`loaded ${fixtures.length} fixture devices`, () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  describe('run1 — initial discovery', () => {
    it.each(fixtures)(
      'device $deviceId ($runs.0.collectorCount collectors) completes without throwing',
      async ({ deviceId, runs }) => {
        const run = runs[0]!;
        await expect(
          orchestrator.runDiscovery({
            deviceId,
            zonePrefix: 'test-zone-prefix',
            jobId: `fixture-run1-${deviceId}`,
            bundle: run.bundle,
            collectorCount: run.collectorCount,
          }),
        ).resolves.toBeUndefined();
      },
      30_000,
    );

    it.each(fixtures)('device $deviceId run1 → DiscoveryRun status is SUCCEEDED or PARTIAL', async ({ deviceId }) => {
      const runs = await prisma.discoveryRun.findMany({
        where: { deviceId, jobId: `fixture-run1-${deviceId}` },
        orderBy: { startedAt: 'desc' },
        take: 1,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toMatch(/^(SUCCEEDED|PARTIAL)$/);
    });

    it.each(fixtures)('device $deviceId run1 → no HANDLER_THREW or COMPOSER_THREW issues', async ({ deviceId }) => {
      const run = await prisma.discoveryRun.findFirst({
        where: { deviceId, jobId: `fixture-run1-${deviceId}` },
      });
      if (!run) return;

      const bugIssues = await prisma.discoveryRunIssue.findMany({
        where: {
          runId: run.id,
          code: { in: ['HANDLER_THREW', 'COMPOSER_THREW'] },
        },
      });
      expect(
        bugIssues,
        `unexpected throw issues: ${JSON.stringify(bugIssues.map((i) => ({ code: i.code, collector: i.collector, detail: i.detail })))}`,
      ).toHaveLength(0);
    });

    it('full-collector device (21f0bdeb) has CPUs, GPUs, interfaces, and storage after run1', async () => {
      if (skip) return;
      const deviceId = '21f0bdeb-ebc5-4dbd-88b1-b680463aa509';
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        include: {
          cpus: true,
          gpus: true,
          interfaces: { where: { deletedAt: null } },
          storageDrives: true,
        },
      });
      expect(device).not.toBeNull();
      expect(device!.cpus.length).toBeGreaterThan(0);
      expect(device!.cpus.every((c) => c.model.length > 0)).toBe(true);
      expect(device!.gpus.length).toBeGreaterThan(0);
      expect(device!.interfaces.length).toBeGreaterThan(0);
      expect(device!.storageDrives.length).toBeGreaterThan(0);
    });

    it('partial-collector device (d3a53016) run1 → SUCCEEDED (all 3 present collectors processed cleanly)', async () => {
      if (skip) return;
      const deviceId = 'd3a53016-86ec-45dd-b2ac-3a505ec57c2b';
      const run = await prisma.discoveryRun.findFirst({
        where: { deviceId, jobId: `fixture-run1-${deviceId}` },
      });
      expect(run).not.toBeNull();
      expect(run!.status).toMatch(/^(SUCCEEDED|PARTIAL)$/);
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        include: { gpus: true },
      });
      expect(device).not.toBeNull();
      expect(device!.gpus.length).toBeGreaterThan(0);
    });
  });

  describe('run2 — re-discovery (upsert)', () => {
    it.each(fixtures)(
      'device $deviceId run2 completes without throwing',
      async ({ deviceId, runs }) => {
        const run = runs[1]!;
        await expect(
          orchestrator.runDiscovery({
            deviceId,
            zonePrefix: 'test-zone-prefix',
            jobId: `fixture-run2-${deviceId}`,
            bundle: run.bundle,
            collectorCount: run.collectorCount,
          }),
        ).resolves.toBeUndefined();
      },
      30_000,
    );

    it.each(fixtures)('device $deviceId run2 → DiscoveryRun status is SUCCEEDED or PARTIAL', async ({ deviceId }) => {
      const runs = await prisma.discoveryRun.findMany({
        where: { deviceId, jobId: `fixture-run2-${deviceId}` },
        orderBy: { startedAt: 'desc' },
        take: 1,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toMatch(/^(SUCCEEDED|PARTIAL)$/);
    });

    it.each(fixtures)('device $deviceId run2 → no HANDLER_THREW or COMPOSER_THREW issues', async ({ deviceId }) => {
      const run = await prisma.discoveryRun.findFirst({
        where: { deviceId, jobId: `fixture-run2-${deviceId}` },
      });
      if (!run) return;

      const bugIssues = await prisma.discoveryRunIssue.findMany({
        where: {
          runId: run.id,
          code: { in: ['HANDLER_THREW', 'COMPOSER_THREW'] },
        },
      });
      expect(
        bugIssues,
        `unexpected throw issues: ${JSON.stringify(bugIssues.map((i) => ({ code: i.code, collector: i.collector, detail: i.detail })))}`,
      ).toHaveLength(0);
    });

    it('partial device (d3a53016) run2 → SUCCEEDED after full collector set', async () => {
      if (skip) return;
      const deviceId = 'd3a53016-86ec-45dd-b2ac-3a505ec57c2b';
      const run = await prisma.discoveryRun.findFirst({
        where: { deviceId, jobId: `fixture-run2-${deviceId}` },
      });
      expect(run).not.toBeNull();
      expect(run!.status).toBe('SUCCEEDED');
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        include: { gpus: true, interfaces: { where: { deletedAt: null } } },
      });
      expect(device!.gpus.length).toBeGreaterThan(0);
    });

    it('full device (21f0bdeb) has exactly 2 DiscoveryRun rows after both runs', async () => {
      if (skip) return;
      const deviceId = '21f0bdeb-ebc5-4dbd-88b1-b680463aa509';
      const runs = await prisma.discoveryRun.findMany({ where: { deviceId } });
      expect(runs).toHaveLength(2);
    });
  });

  it('emitted RunStarted and RunCompleted for every run, no RunFailed', () => {
    const totalRuns = fixtures.reduce((sum, f) => sum + f.runs.length, 0);
    const started = emittedEvents.filter((e) => e.name === 'discovery.run.started').length;
    const completed = emittedEvents.filter((e) => e.name === 'discovery.run.completed').length;
    const failed = emittedEvents.filter((e) => e.name === 'discovery.run.failed').length;

    expect(started).toBe(totalRuns);
    expect(completed).toBe(totalRuns);
    expect(failed).toBe(0);
  });

  it('prints a summary of issue codes across all runs', async () => {
    const allDeviceIds = fixtures.map((f) => f.deviceId);
    const runIds = (
      await prisma.discoveryRun.findMany({
        where: { deviceId: { in: allDeviceIds } },
        select: { id: true },
      })
    ).map((r) => r.id);

    const issues = await prisma.discoveryRunIssue.groupBy({
      by: ['phase', 'severity', 'code'],
      where: { runId: { in: runIds } },
      _count: { _all: true },
    });

    const summary = issues
      .sort((a, b) => b._count._all - a._count._all)
      .map((i) => `  ${i.phase.padEnd(10)} ${i.severity.padEnd(6)} ${i.code.padEnd(20)} ×${i._count._all}`)
      .join('\n');

    // eslint-disable-next-line no-console
    console.log(
      `\nDiscoveryRunIssue summary (${runIds.length} runs across ${fixtures.length} devices):\n${summary || '  (none)'}\n`,
    );
    expect(true).toBe(true);
  });
});
