import { DeviceStatus, Prisma, ServerLifecycleStatus, ServerPowerStatus, type PrismaClient } from '@repo/database';
import { serverPowerStatusToLegacy } from '@repo/device-domain';
import type { Queue } from 'bullmq';
import { ensureError, getErrorMessage } from 'src/common/error-utils';
import {
  STATUS_TRANSITION_JOB,
  type StatusTransitionJob,
} from 'src/devices/device-status-effects/device-status-effects.types';
import { detectStatusTransition } from 'src/devices/device-status-effects/transitions';
import { DEVICE_METADATA_UPDATED } from 'src/events/events.types';
import type { RedisPubSubService } from 'src/events/redis-pubsub.service';
import type { LoggerService } from 'src/logger/logger.service';

const WATCHED_FIELDS = ['status'] as const;

const SERVER_WATCHED_FIELDS = ['powerStatus', 'lifecycleStatus'] as const;

interface BeforeRow {
  id: string;
  status: DeviceStatus | null;
  powerStatus: ServerPowerStatus | null;
  lifecycleStatus: ServerLifecycleStatus | null;
}

interface AfterRow {
  id: string;
  status: DeviceStatus | null;
  powerStatus: ServerPowerStatus | null;
  lifecycleStatus: ServerLifecycleStatus | null;
  deployments: { id: string; customerId: string }[];
  supplierId: string | null;
}

interface ExtensionDeps {
  redisPubSub: RedisPubSubService;
  statusEffectsQueue: Queue;
  baseClient: PrismaClient;
  logger: LoggerService;
}

function deviceUniqueWhereId(where: Prisma.DeviceWhereUniqueInput): string | undefined {
  if (typeof where.id === 'string') return where.id;
  return undefined;
}

async function captureBefore(ids: string[], baseClient: PrismaClient): Promise<Map<string, BeforeRow>> {
  if (ids.length === 0) return new Map();
  const rows = await baseClient.device.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, server: { select: { lifecycleStatus: true, powerStatus: true } } },
  });
  return new Map(
    rows.map(({ server, ...r }) => [
      r.id,
      { ...r, lifecycleStatus: server?.lifecycleStatus ?? null, powerStatus: server?.powerStatus ?? null },
    ]),
  );
}

async function captureAfter(ids: string[], baseClient: PrismaClient): Promise<AfterRow[]> {
  if (ids.length === 0) return [];
  const rows = await baseClient.device.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      supplierId: true,
      server: {
        select: {
          lifecycleStatus: true,
          powerStatus: true,
          deployments: {
            where: { endDate: null },
            select: { id: true, customerId: true },
            take: 1,
          },
        },
      },
    },
  });
  return rows.map(({ server, ...rest }) => ({
    ...rest,
    lifecycleStatus: server?.lifecycleStatus ?? null,
    powerStatus: server?.powerStatus ?? null,
    deployments: server?.deployments ?? [],
  }));
}

async function fanOut(before: BeforeRow | undefined, after: AfterRow, deps: ExtensionDeps): Promise<void> {
  const activeDeployment = after.deployments[0] ?? null;

  try {
    await deps.redisPubSub.publish({
      type: DEVICE_METADATA_UPDATED,
      deviceId: after.id,
      deploymentId: activeDeployment?.id ?? null,
      organizationId: activeDeployment?.customerId ?? null,
      supplierId: after.supplierId,
      status: (after.lifecycleStatus ?? after.status)?.toLowerCase() ?? null,
      powerStatus: serverPowerStatusToLegacy(after.powerStatus ?? null),
    });
  } catch (error) {
    deps.logger.warn(`Failed to publish SSE event for device ${after.id}: ${getErrorMessage(error)}`);
  }

  if (!before) return;

  const transition = detectStatusTransition(before.lifecycleStatus, after.lifecycleStatus);
  if (!transition) return;

  const payload: StatusTransitionJob = {
    deviceId: after.id,
    transition,
    fromStatus: before.lifecycleStatus,
    toStatus: after.lifecycleStatus,
  };

  try {
    await deps.statusEffectsQueue.add(STATUS_TRANSITION_JOB, payload, {
      jobId: `device-${after.id}-${after.lifecycleStatus}-${Date.now()}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  } catch (error) {
    deps.logger.error(
      `Failed to enqueue status transition job for device ${after.id} (${transition}): ${getErrorMessage(error)}`,
      ensureError(error).stack,
    );
  }
}

async function fanOutForDeviceIds(
  ids: string[],
  beforeMap: Map<string, BeforeRow>,
  deps: ExtensionDeps,
): Promise<void> {
  const afterRows = await captureAfter(ids, deps.baseClient);
  await Promise.all(afterRows.map((row) => fanOut(beforeMap.get(row.id), row, deps)));
}

function isEnumSetOp<E extends string>(raw: E | { set?: E | null } | null | undefined): raw is { set?: E | null } {
  return typeof raw === 'object' && raw !== null;
}

function unwrapEnumWrite<E extends string>(raw: E | { set?: E | null } | null | undefined): E | null | undefined {
  if (isEnumSetOp(raw)) return raw.set ?? null;
  return raw;
}

async function fanOutServerWrite(
  baseline: AfterRow[],
  data:
    | Prisma.ServerUpdateInput
    | Prisma.ServerUncheckedUpdateInput
    | Prisma.ServerUpdateManyMutationInput
    | Prisma.ServerUncheckedUpdateManyInput,
  deps: ExtensionDeps,
): Promise<void> {
  const overlay: Partial<Pick<AfterRow, 'powerStatus' | 'lifecycleStatus'>> = {};
  if ('powerStatus' in data) overlay.powerStatus = unwrapEnumWrite(data.powerStatus) ?? null;
  if ('lifecycleStatus' in data) overlay.lifecycleStatus = unwrapEnumWrite(data.lifecycleStatus) ?? null;
  await Promise.all(baseline.map((row) => fanOut(row, { ...row, ...overlay }, deps)));
}

export function createDeviceEffectsExtension(deps: ExtensionDeps) {
  return Prisma.defineExtension({
    query: {
      device: {
        async update({ args, query }) {
          const writesWatched = WATCHED_FIELDS.some((f) => args.data && f in args.data);
          const serverWrite = args.data?.server;
          const writesServerState =
            typeof serverWrite === 'object' &&
            serverWrite !== null &&
            ('update' in serverWrite || 'upsert' in serverWrite);

          if (!writesWatched && !writesServerState) return query(args);

          const whereId = deviceUniqueWhereId(args.where);
          if (whereId === undefined) return query(args);

          const beforeMap = await captureBefore([whereId], deps.baseClient);
          const result = await query(args);

          try {
            const after = await captureAfter([whereId], deps.baseClient);
            if (after[0]) {
              await fanOut(beforeMap.get(whereId), after[0], deps);
            }
          } catch (error) {
            deps.logger.error(
              `Post-write side effects failed for device ${whereId}: ${getErrorMessage(error)}`,
              ensureError(error).stack,
            );
          }

          return result;
        },

        async updateMany({ args, query }) {
          const writesWatched = WATCHED_FIELDS.some((f) => args.data && f in args.data);
          if (!writesWatched) return query(args);

          // Capture matching IDs before the write — it may change which rows match `args.where`.
          const matches = await deps.baseClient.device.findMany({
            where: args.where ?? {},
            select: { id: true },
          });
          const ids = matches.map((m) => m.id);
          const beforeMap = await captureBefore(ids, deps.baseClient);

          const result = await query(args);
          if (result.count === 0) return result;

          try {
            await fanOutForDeviceIds(ids, beforeMap, deps);
          } catch (error) {
            deps.logger.error(
              `Post-write side effects failed for ${ids.length} device(s): ${getErrorMessage(error)}`,
              ensureError(error).stack,
            );
          }

          return result;
        },
      },

      server: {
        async update({ args, query }) {
          const data = args.data;
          if (!data || !SERVER_WATCHED_FIELDS.some((f) => f in data)) return query(args);

          const target = await deps.baseClient.server.findUnique({
            where: args.where,
            select: { deviceId: true },
          });
          if (!target) return query(args);

          const baseline = await captureAfter([target.deviceId], deps.baseClient);
          const result = await query(args);

          try {
            await fanOutServerWrite(baseline, data, deps);
          } catch (error) {
            deps.logger.error(
              `Post-write side effects failed for device ${target.deviceId}: ${getErrorMessage(error)}`,
              ensureError(error).stack,
            );
          }

          return result;
        },

        async updateMany({ args, query }) {
          const data = args.data;
          if (!data || !SERVER_WATCHED_FIELDS.some((f) => f in data)) return query(args);

          const matches = await deps.baseClient.server.findMany({
            where: args.where ?? {},
            select: { deviceId: true },
          });
          const ids = matches.map((m) => m.deviceId);
          const baseline = await captureAfter(ids, deps.baseClient);

          const result = await query(args);
          if (result.count === 0) return result;

          try {
            await fanOutServerWrite(baseline, data, deps);
          } catch (error) {
            deps.logger.error(
              `Post-write side effects failed for ${ids.length} server device(s): ${getErrorMessage(error)}`,
              ensureError(error).stack,
            );
          }

          return result;
        },
      },
    },
  });
}
