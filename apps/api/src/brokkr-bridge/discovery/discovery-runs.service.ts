import { Injectable } from '@nestjs/common';
import type { DiscoveryRun, Prisma } from '@repo/database';
import type { ModelFieldPaths, PaginationQuery } from '@repo/database/pagination';
import { createPaginationConfig, paginateQuery } from '@repo/database/pagination';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { PrismaClient } from 'src/prisma/prisma.client';

type DiscoveryRunField = ModelFieldPaths<DiscoveryRun>;

const discoveryRunsPaginationConfig = createPaginationConfig<DiscoveryRunField>({
  searchableFields: ['jobId', 'handlerVersion'],
  sortableFields: {
    startedAt: 'startedAt',
    status: 'status',
    durationMs: 'durationMs',
  },
  // `id` breaks ties so offset pages can't skip or repeat runs that share a startedAt.
  defaultSort: [
    { field: 'startedAt', direction: 'desc' },
    { field: 'id', direction: 'desc' },
  ],
  defaultPageSize: 25,
});

type DiscoveryRunWithIssues = Prisma.DiscoveryRunGetPayload<{ include: { issues: true } }>;

@Injectable()
export class DiscoveryRunsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listForDevice(deviceId: string, query: PaginationQuery) {
    // Read purely for its tenant pin and `device:read` gate — a device outside the caller org 404s here.
    await BaremetalRecord.findByDeviceIdOrThrow(deviceId);

    const result = await paginateQuery<DiscoveryRunWithIssues>(
      this.prisma.discoveryRun,
      query,
      discoveryRunsPaginationConfig,
      {
        where: { deviceId },
        include: { issues: { orderBy: { createdAt: 'asc' } } },
      },
    );

    return { data: result.data.map(toResponse), meta: result.meta };
  }
}

function toResponse(run: DiscoveryRunWithIssues) {
  return {
    id: run.id,
    deviceId: run.deviceId,
    status: run.status,
    jobId: run.jobId,
    zonePrefix: run.zonePrefix,
    handlerVersion: run.handlerVersion,
    bridgeCollectorVersion: run.bridgeCollectorVersion,
    collectorsExpected: run.collectorsExpected,
    collectorsReceived: run.collectorsReceived,
    collectorsApplied: run.collectorsApplied,
    collectorsSkipped: run.collectorsSkipped,
    composersApplied: run.composersApplied,
    s3Prefix: run.s3Prefix,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs: run.durationMs,
    issues: run.issues.map((issue) => ({
      id: issue.id,
      phase: issue.phase,
      collector: issue.collector,
      code: issue.code,
      severity: issue.severity,
      detail: issue.detail,
      createdAt: issue.createdAt.toISOString(),
    })),
  };
}
