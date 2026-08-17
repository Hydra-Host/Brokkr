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
import { loadProdSamples } from './load-prod-samples';
import { cleanupSeededDevices, seedDevices } from './seed-devices';


const samples = loadProdSamples();
const skip = samples.length === 0 || !process.env.DATABASE_URL;

const silentLogger = {
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
    samples.map((s) => s.deviceId),
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
}, 60000);

afterAll(async () => {
  if (skip) return;
  if (process.env.KEEP_DISCOVERY_RUN_DATA !== 'true') {
    await cleanupSeededDevices(
      prisma,
      samples.map((s) => s.deviceId),
    );
  }
  await prisma.$disconnect();
}, 60000);

describe.skipIf(skip)('DiscoveryOrchestrator — prod sample replay', () => {
  it(`loaded ${samples.length} devices from .discovery-samples/data/`, () => {
    expect(samples.length).toBeGreaterThan(0);
  });

  it.each(samples)(
    'device deviceId=$deviceId ($collectorCount collectors) completes without throwing',
    async ({ deviceId, bundle, collectorCount }) => {
      await expect(
        orchestrator.runDiscovery({
          deviceId,
          zonePrefix: 'test-tenant-site-loc',
          jobId: `replay-${deviceId}`,
          bundle,
          collectorCount,
        }),
      ).resolves.toBeUndefined();

      const runs = await prisma.discoveryRun.findMany({
        where: { deviceId, jobId: `replay-${deviceId}` },
        orderBy: { startedAt: 'desc' },
        take: 1,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toMatch(/^(SUCCEEDED|PARTIAL)$/);

      const errorIssues = await prisma.discoveryRunIssue.findMany({
        where: { runId: runs[0]!.id, severity: 'ERROR' },
      });
      const bugCodes = errorIssues.filter((i) => i.code === 'HANDLER_THREW' || i.code === 'COMPOSER_THREW');
      expect(
        bugCodes,
        `expected no HANDLER_THREW/COMPOSER_THREW on deviceId=${deviceId}, got: ${JSON.stringify(
          bugCodes.map((i) => ({ code: i.code, collector: i.collector, detail: i.detail })),
          null,
          2,
        )}`,
      ).toHaveLength(0);
    },
    60000,
  );

  it('emitted exactly one RunStarted + one RunCompleted per device (no RunFailed)', () => {
    const started = emittedEvents.filter((e) => e.name === 'discovery.run.started').length;
    const completed = emittedEvents.filter((e) => e.name === 'discovery.run.completed').length;
    const failed = emittedEvents.filter((e) => e.name === 'discovery.run.failed').length;

    expect(started).toBe(samples.length);
    expect(completed).toBe(samples.length);
    expect(failed).toBe(0);
  });

  it('prints a summary of issue codes across all devices', async () => {
    const runIds = (
      await prisma.discoveryRun.findMany({
        where: { deviceId: { in: samples.map((s) => s.deviceId) } },
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
    console.log(`\nDiscoveryRunIssue summary across ${runIds.length} devices:\n${summary}\n`);
    expect(true).toBe(true);
  });
});
