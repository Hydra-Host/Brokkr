import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { randomUUID } from 'node:crypto';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { applyMutations } from './apply-mutations';
import { CollectorRegistry } from './collectors/collector.registry';
import type { CollectorContext, DeviceMutation, RawCollectorBundle } from './collectors/collector.types';
import { ComposerRegistry } from './composers/composer.registry';
import { DiscoveryEventsService } from './discovery-events.service';
import { DiscoveryRunIssueRecorder } from './discovery-run-issue.recorder';
import { DiscoveryS3UploadService } from './discovery-s3-upload.service';
import { DiscoveryEvent } from './discovery.events';
import { countUpserts, mergeMutations } from './merge-mutations';

@Injectable()
export class DiscoveryOrchestratorService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly collectorRegistry: CollectorRegistry,
    private readonly composerRegistry: ComposerRegistry,
    private readonly s3: DiscoveryS3UploadService,
    private readonly events: DiscoveryEventsService,
    private readonly recorder: DiscoveryRunIssueRecorder,
    @Logger(DiscoveryOrchestratorService.name) private readonly logger: LoggerService,
  ) {}

  async runDiscovery(input: {
    deviceId: string;
    zonePrefix: string;
    jobId: string;
    bundle: RawCollectorBundle;
    collectorCount: number;
  }): Promise<void> {
    const { deviceId, zonePrefix, jobId, bundle, collectorCount } = input;
    const runId = randomUUID();
    const startedAt = new Date();
    const runTimestamp = DiscoveryS3UploadService.runTimestamp(startedAt);
    const s3Prefix = DiscoveryS3UploadService.prefixFor(deviceId, runTimestamp);

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { server: true },
    });
    if (!device) {
      this.logger.warn(`Discovery received for unknown device id=${deviceId}; no Device row yet — skipping`, jobId);
      return;
    }

    const bridgeCollectorVersion = extractCollectorVersion(bundle);

    await this.prisma.discoveryRun.create({
      data: {
        id: runId,
        deviceId: device.id,
        status: 'STARTED',
        jobId,
        zonePrefix,
        handlerVersion: process.env.GIT_SHA ?? 'dev',
        bridgeCollectorVersion,
        s3Prefix,
        collectorsExpected: collectorCount,
        collectorsReceived: Object.keys(bundle).length,
        startedAt,
      },
    });

    this.events.emit(DiscoveryEvent.RunStarted, {
      runId,
      deviceId: device.id,
      jobId,
      zonePrefix,
      startedAt,
    });

    const ctx: CollectorContext = {
      runId,
      deviceId: device.id,
      device,
      rawBundle: bundle,
      logger: this.logger,
    };

    const buffered: DeviceMutation = {};
    const collectorsApplied: string[] = [];
    const collectorsSkipped: string[] = [];

    for (const [collector, raw] of Object.entries(bundle)) {
      await this.s3.uploadCollectorPayload(deviceId, runTimestamp, collector, raw);
      const rawBytes = typeof raw === 'string' ? raw.length : safeByteLength(raw);
      this.events.emit(DiscoveryEvent.CollectorReceived, {
        runId,
        deviceId: device.id,
        collector,
        rawBytes,
      });

      const handler = this.collectorRegistry.get(collector);
      if (!handler) {
        collectorsSkipped.push(collector);
        await this.recorder.record({
          runId,
          deviceId: device.id,
          phase: 'HANDLER',
          collector,
          code: 'NO_HANDLER',
          severity: 'INFO',
        });
        continue;
      }

      const parsed = handler.schema.safeParse(raw);
      if (!parsed.success) {
        collectorsSkipped.push(collector);
        await this.recorder.record({
          runId,
          deviceId: device.id,
          phase: 'SCHEMA',
          collector,
          code: 'PARSE_FAILED',
          severity: 'WARN',
          detail: JSON.parse(JSON.stringify(parsed.error.issues.slice(0, 5))) as Prisma.InputJsonValue,
        });
        this.events.emit(DiscoveryEvent.CollectorInvalid, {
          runId,
          deviceId: device.id,
          collector,
          issues: parsed.error.issues,
        });
        continue;
      }

      try {
        const mutation = await handler.handle(parsed.data, ctx);
        mergeMutations(buffered, mutation);
        collectorsApplied.push(collector);
        for (const warning of mutation.warnings ?? []) {
          await this.recorder.record({
            runId,
            deviceId: device.id,
            phase: 'HANDLER',
            collector,
            code: 'WARN',
            severity: 'INFO',
            detail: warning,
          });
        }
        this.events.emit(DiscoveryEvent.CollectorApplied, {
          runId,
          deviceId: device.id,
          collector,
          warnings: mutation.warnings ?? [],
          deviceUpdateKeys: Object.keys(mutation.deviceUpdate ?? {}),
          serverUpdateKeys: Object.keys(mutation.serverUpdate ?? {}),
          upsertCounts: countUpserts(mutation.upserts),
        });
      } catch (error) {
        collectorsSkipped.push(collector);
        const message = getErrorMessage(error);
        await this.recorder.record({
          runId,
          deviceId: device.id,
          phase: 'HANDLER',
          collector,
          code: 'HANDLER_THREW',
          severity: 'ERROR',
          detail: message,
        });
        this.events.emit(DiscoveryEvent.CollectorFailed, {
          runId,
          deviceId: device.id,
          collector,
          error: message,
        });
      }
    }

    const composersApplied: string[] = [];
    for (const composer of this.composerRegistry.all()) {
      try {
        const mutation = await composer.compose(ctx, buffered);
        mergeMutations(buffered, mutation);
        composersApplied.push(composer.name);
        for (const warning of mutation.warnings ?? []) {
          await this.recorder.record({
            runId,
            deviceId: device.id,
            phase: 'COMPOSER',
            composer: composer.name,
            code: 'WARN',
            severity: 'INFO',
            detail: warning,
          });
        }
        this.events.emit(DiscoveryEvent.ComposerApplied, {
          runId,
          deviceId: device.id,
          composer: composer.name,
          warnings: mutation.warnings ?? [],
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await this.recorder.record({
          runId,
          deviceId: device.id,
          phase: 'COMPOSER',
          composer: composer.name,
          code: 'COMPOSER_THREW',
          severity: 'ERROR',
          detail: message,
        });
        this.events.emit(DiscoveryEvent.ComposerFailed, {
          runId,
          deviceId: device.id,
          composer: composer.name,
          error: message,
        });
      }
    }

    try {
      const applyResult = await applyMutations(this.prisma, device.id, buffered, this.logger);
      if (applyResult.upsertCounts['serverUpdate:skipped']) {
        await this.recorder.record({
          runId,
          deviceId: device.id,
          phase: 'COMMIT',
          code: 'SERVER_ROW_ABSENT',
          severity: 'INFO',
          detail:
            'serverUpdate discarded: no Server row exists yet — enrichment lands on a later pass once qualify creates it',
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      await this.recorder.record({
        runId,
        deviceId: device.id,
        phase: 'COMMIT',
        code: 'COMMIT_FAILED',
        severity: 'ERROR',
        detail: message,
      });
      await this.finaliseRun({
        runId,
        startedAt,
        status: 'FAILED',
        collectorsApplied,
        collectorsSkipped,
        composersApplied,
      });
      this.events.emit(DiscoveryEvent.RunFailed, {
        runId,
        deviceId: device.id,
        jobId,
        phase: 'commit',
        error: message,
      });
      throw error;
    }

    const durationMs = Date.now() - startedAt.getTime();
    const issuesBySeverity = await this.prisma.discoveryRunIssue.groupBy({
      by: ['severity'],
      where: { runId },
      _count: { _all: true },
    });
    const issueCount = issuesBySeverity.reduce((sum, row) => sum + row._count._all, 0);
    const blockingIssueCount = issuesBySeverity
      .filter((row) => row.severity === 'WARN' || row.severity === 'ERROR')
      .reduce((sum, row) => sum + row._count._all, 0);
    const status: 'SUCCEEDED' | 'PARTIAL' =
      collectorsSkipped.length > 0 || blockingIssueCount > 0 ? 'PARTIAL' : 'SUCCEEDED';

    await this.finaliseRun({ runId, startedAt, status, collectorsApplied, collectorsSkipped, composersApplied });

    this.events.emit(DiscoveryEvent.RunCompleted, {
      runId,
      deviceId: device.id,
      zonePrefix,
      jobId,
      storageLayouts: extractStorageLayouts(buffered),
      rawBundle: bundle,
      collectorsApplied,
      collectorsSkipped,
      composersApplied,
      issueCount,
      durationMs,
    });
  }

  private async finaliseRun(args: {
    runId: string;
    startedAt: Date;
    status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
    collectorsApplied: string[];
    collectorsSkipped: string[];
    composersApplied: string[];
  }): Promise<void> {
    const completedAt = new Date();
    await this.prisma.discoveryRun.update({
      where: { id: args.runId },
      data: {
        status: args.status,
        completedAt,
        durationMs: completedAt.getTime() - args.startedAt.getTime(),
        collectorsApplied: args.collectorsApplied,
        collectorsSkipped: args.collectorsSkipped,
        composersApplied: args.composersApplied,
      },
    });
  }
}

function extractCollectorVersion(bundle: RawCollectorBundle): string | null {
  const meta = bundle.collection_metadata;
  if (meta && typeof meta === 'object' && 'collector_version' in meta) {
    const value = (meta as { collector_version?: unknown }).collector_version;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function extractStorageLayouts(mutation: DeviceMutation): unknown {
  return mutation.serverUpdate?.storageLayouts ?? null;
}

function safeByteLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
