import { Prisma } from '@repo/database';
import { sleep } from '@repo/utils';
import { getErrorMessage } from 'src/common/error-utils';
import { ensureIpAddress } from 'src/common/ipam/ensure-ip-address';
import { ensureNatMapping } from 'src/common/ipam/ensure-nat-mapping';
import type { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import type { DeviceMutation, MutationUpserts } from './collectors/collector.types';

interface ApplyMutationsOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
}

// Only deadlock (40P01) + serialization (40001) failures retry — Prisma surfaces them as P2034/P2024.
const RETRYABLE_PRISMA_CODES = new Set(['P2034', 'P2024']);
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

export interface ApplyMutationsResult {
  deviceUpdateKeys: string[];
  upsertCounts: Record<string, number>;
  attempts: number;
}

export async function applyMutations(
  prisma: PrismaClient,
  deviceId: string,
  mutation: DeviceMutation,
  logger: LoggerService,
  options: ApplyMutationsOptions = {},
): Promise<ApplyMutationsResult> {
  const maxRetries = options.maxRetries ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 50;

  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const result = await prisma.$transaction(async (tx) => runMutation(tx, deviceId, mutation), {
        timeout: 30_000,
        maxWait: 10_000,
      });
      return { ...result, attempts: attempt };
    } catch (error) {
      if (attempt > maxRetries || !isRetryable(error)) {
        throw error;
      }
      const backoff = baseBackoffMs * 2 ** (attempt - 1);
      logger.warn(
        `applyMutations retryable failure (attempt ${attempt}/${maxRetries}) for device ${deviceId}: ${getErrorMessage(error)} — retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
}

async function runMutation(
  tx: Prisma.TransactionClient,
  deviceId: string,
  mutation: DeviceMutation,
): Promise<Omit<ApplyMutationsResult, 'attempts'>> {
  const upsertCounts: Record<string, number> = {};

  if (mutation.deviceUpdate && Object.keys(mutation.deviceUpdate).length > 0) {
    await tx.device.update({
      where: { id: deviceId },
      data: mutation.deviceUpdate,
    });
  }

  if (mutation.serverUpdate && Object.keys(mutation.serverUpdate).length > 0) {
    const { count } = await tx.server.updateMany({ where: { deviceId }, data: mutation.serverUpdate });
    if (count === 0) upsertCounts['serverUpdate:skipped'] = 1;
  }

  await upsertChildren(tx, deviceId, mutation.upserts, upsertCounts);

  return {
    deviceUpdateKeys: Object.keys(mutation.deviceUpdate ?? {}),
    upsertCounts,
  };
}

async function upsertChildren(
  tx: Prisma.TransactionClient,
  deviceId: string,
  upserts: MutationUpserts | undefined,
  counts: Record<string, number>,
): Promise<void> {
  if (!upserts) return;

  if (upserts.cpus?.length) {
    for (const cpu of upserts.cpus) {
      await tx.cpu.upsert({
        where: { deviceId_socketIndex: { deviceId, socketIndex: cpu.socketIndex } },
        create: { deviceId, ...cpu },
        update: cpu,
      });
    }
    counts.cpus = upserts.cpus.length;
  }

  if (upserts.gpus?.length) {
    for (const gpu of upserts.gpus) {
      await tx.gpu.upsert({
        where: { deviceId_index: { deviceId, index: gpu.index } },
        create: { deviceId, ...gpu },
        update: gpu,
      });
    }
    counts.gpus = upserts.gpus.length;

    // sweeps GPUs this scan didn't report — a pulled or failed card. Same gate as
    // the drive sweep below: `nvidia` enumerates every GPU, and an empty report
    // (CC-mode / no driver) emits no upserts at all, so it sweeps nothing rather
    // than dropping the count to zero. Without this, `projectHardwareSummary`
    // keeps counting stale rows.
    const reportedIndexes = upserts.gpus.map((gpu) => gpu.index);
    const { count: removed } = await tx.gpu.deleteMany({
      where: { deviceId, index: { notIn: reportedIndexes } },
    });
    if (removed > 0) counts['gpus:removed'] = removed;

    // NvlinkEdge stores endpoints as bare indices with only a Device FK, so dropping a Gpu row
    // cascades nothing. Sweep edges whose either endpoint is gone, or the topology keeps pointing
    // at a card that no longer exists — impossible before the sweep above, since Gpu rows were
    // never deleted. The nvlink collector has no sweep of its own.
    const { count: edgesRemoved } = await tx.nvlinkEdge.deleteMany({
      where: {
        deviceId,
        OR: [{ sourceGpuIndex: { notIn: reportedIndexes } }, { targetGpuIndex: { notIn: reportedIndexes } }],
      },
    });
    if (edgesRemoved > 0) counts['nvlinkEdges:removed'] = edgesRemoved;
  }

  if (upserts.storageDrives?.length) {
    for (const drive of upserts.storageDrives) {
      await tx.storageDrive.upsert({
        where: { deviceId_name: { deviceId, name: drive.name } },
        create: { deviceId, ...drive },
        update: drive,
      });
    }
    counts.storageDrives = upserts.storageDrives.length;

    // sweeps drives this scan didn't report — a pulled disk, or a synthesized row
    // ("nvme0") the real lsblk name ("nvme0n1") can't collide with, so the upsert
    // above can never reclaim it. Gated on a non-empty report: both storage
    // collectors enumerate every disk, so a missing one must sweep nothing rather
    // than wipe the inventory.
    const reported = upserts.storageDrives.map((drive) => drive.name);
    const { count: removed } = await tx.storageDrive.deleteMany({
      where: { deviceId, name: { notIn: reported } },
    });
    if (removed > 0) counts['storageDrives:removed'] = removed;
  }

  if (upserts.memoryConfig) {
    await tx.memoryConfig.upsert({
      where: { deviceId },
      create: { deviceId, ...upserts.memoryConfig },
      update: upserts.memoryConfig,
    });
    counts.memoryConfig = 1;
  }

  let ipAddressOrgId: string | null | undefined;
  const resolveIpAddressOrgId = async (): Promise<string | null> => {
    if (ipAddressOrgId !== undefined) return ipAddressOrgId;
    const device = await tx.device.findUnique({
      where: { id: deviceId },
      select: { organizationId: true, supplierId: true, zone: { select: { organizationId: true } } },
    });
    ipAddressOrgId = device?.supplierId ?? device?.zone?.organizationId ?? null;
    return ipAddressOrgId;
  };

  if (upserts.interfaces?.length) {
    for (const upsert of upserts.interfaces) {
      const { ipAddresses, ...iface } = upsert;

      let interfaceId: string | null = null;
      if (iface.macAddress) {
        const byName = await tx.interface.findFirst({
          where: { deviceId, name: iface.name, deletedAt: null },
          select: { id: true },
        });
        if (!byName) {
          const enrichmentRow = await tx.interface.findFirst({
            where: {
              deviceId,
              name: 'eth0',
              deletedAt: null,
              macAddress: { equals: iface.macAddress, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (enrichmentRow) {
            await tx.interface.update({ where: { id: enrichmentRow.id }, data: iface, select: { id: true } });
            interfaceId = enrichmentRow.id;
          }
        }
      }

      if (interfaceId === null) {
        const existing = await tx.interface.findFirst({
          where: { deviceId, name: iface.name, deletedAt: null },
          select: { id: true },
        });
        const row = existing
          ? await tx.interface.update({ where: { id: existing.id }, data: iface, select: { id: true } })
          : await tx.interface.create({ data: { deviceId, ...iface }, select: { id: true } });
        interfaceId = row.id;
      }

      if (ipAddresses?.length) {
        const orgId = await resolveIpAddressOrgId();
        if (orgId) {
          for (const address of ipAddresses) {
            const outcome = await ensureIpAddress(tx, { address, interfaceId, deviceId, organizationId: orgId });
            const bucket =
              outcome === 'invalid' || outcome === 'assigned-elsewhere' ? `ipAddresses:${outcome}` : 'ipAddresses';
            counts[bucket] = (counts[bucket] ?? 0) + 1;
          }
        } else {
          counts['ipAddresses:no-org'] = (counts['ipAddresses:no-org'] ?? 0) + ipAddresses.length;
        }
      }
    }
    counts.interfaces = upserts.interfaces.length;
  }

  if (upserts.natMappings?.length) {
    const orgId = await resolveIpAddressOrgId();
    if (orgId) {
      for (const mapping of upserts.natMappings) {
        const outcome = await ensureNatMapping(tx, { ...mapping, organizationId: orgId, deviceId });
        const bucket = outcome === 'linked' || outcome === 'unchanged' ? 'natMappings' : `natMappings:${outcome}`;
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
    } else {
      counts['natMappings:no-org'] = (counts['natMappings:no-org'] ?? 0) + upserts.natMappings.length;
    }
  }

  if (upserts.firmwares?.length) {
    for (const fw of upserts.firmwares) {
      await tx.deviceFirmware.upsert({
        where: { deviceId_type: { deviceId, type: fw.type } },
        create: { deviceId, ...fw },
        update: fw,
      });
    }
    counts.firmwares = upserts.firmwares.length;
  }

  if (upserts.pciDevices?.length) {
    for (const pci of upserts.pciDevices) {
      await tx.pciDevice.upsert({
        where: { deviceId_address: { deviceId, address: pci.address } },
        create: { deviceId, ...pci },
        update: pci,
      });
    }
    counts.pciDevices = upserts.pciDevices.length;
  }

  if (upserts.uefiBootEntries?.length) {
    for (const entry of upserts.uefiBootEntries) {
      await tx.uefiBootEntry.upsert({
        where: {
          deviceId_bootOptionReference: { deviceId, bootOptionReference: entry.bootOptionReference },
        },
        create: { deviceId, ...entry },
        update: entry,
      });
    }
    counts.uefiBootEntries = upserts.uefiBootEntries.length;
  }

  if (upserts.nvlinkEdges?.length) {
    for (const edge of upserts.nvlinkEdges) {
      await tx.nvlinkEdge.upsert({
        where: {
          deviceId_sourceGpuIndex_targetGpuIndex: {
            deviceId,
            sourceGpuIndex: edge.sourceGpuIndex,
            targetGpuIndex: edge.targetGpuIndex,
          },
        },
        create: { deviceId, ...edge },
        update: edge,
      });
    }
    counts.nvlinkEdges = upserts.nvlinkEdges.length;
  }

  if (upserts.solConfig) {
    await tx.deviceSolConfig.upsert({
      where: { deviceId },
      create: { deviceId, ...upserts.solConfig },
      update: upserts.solConfig,
    });
    counts.solConfig = 1;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_PRISMA_CODES.has(error.code)) return true;
    const meta = error.meta as { code?: string } | undefined;
    if (meta?.code && RETRYABLE_PG_CODES.has(meta.code)) return true;
  }
  return false;
}
