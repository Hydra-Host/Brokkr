import { Prisma } from '@repo/database';
import { formatMacAddress } from '@repo/database/extensions/mac-address';
import { sleep } from '@repo/utils';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from 'src/common/error-utils';
import { ensureIpAddress } from 'src/common/ipam/ensure-ip-address';
import { ensureNatMapping } from 'src/common/ipam/ensure-nat-mapping';
import type { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import type { DeviceMutation, MutationUpserts, PciDeviceUpsert } from './collectors/collector.types';

interface ApplyMutationsOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
}

// Only deadlock (40P01) + serialization (40001) failures retry — Prisma surfaces them as P2034/P2024.
const RETRYABLE_PRISMA_CODES = new Set(['P2034', 'P2024']);
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

// 13 bind params per row; 500 rows is 6.5k, well inside Postgres's 65535 cap.
const PCI_CHUNK = 500;

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
      const result = await prisma.$transaction(async (tx) => runMutation(tx, deviceId, mutation, logger), {
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
  logger: LoggerService,
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

  await upsertChildren(tx, deviceId, mutation.upserts, upsertCounts, mutation.pciDevicesPartial === true, logger);

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
  pciDevicesPartial: boolean,
  logger: LoggerService,
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

    // Sweep GPUs this scan didn't report. Empty nvidia reports (CC-mode / no driver)
    // emit no upserts, so skip rather than dropping the count to zero.
    const reportedIndexes = upserts.gpus.map((gpu) => gpu.index);
    const { count: removed } = await tx.gpu.deleteMany({
      where: { deviceId, index: { notIn: reportedIndexes } },
    });
    if (removed > 0) counts['gpus:removed'] = removed;

    // NvlinkEdge endpoints are bare indices with only a Device FK — dropping a Gpu
    // cascades nothing, so sweep edges whose either endpoint is gone.
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

    // Sweep drives this scan didn't report. Gated on a non-empty report so a missing
    // collector doesn't wipe inventory.
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
      select: { supplierId: true, zone: { select: { organizationId: true } } },
    });
    ipAddressOrgId = device?.supplierId ?? device?.zone?.organizationId ?? null;
    return ipAddressOrgId;
  };

  if (upserts.interfaces?.length) {
    // Rows written earlier in this pass: a later interface reporting the same MAC must not take them over.
    const writtenIds = new Set<string>();
    for (const upsert of upserts.interfaces) {
      const { ipAddresses, ...iface } = upsert;
      const data = { ...iface };

      const byName = await tx.interface.findFirst({
        where: { deviceId, name: data.name, deletedAt: null },
        select: { id: true },
      });
      // Canonicalised like the write extension stores it, so a hyphen/uppercase report still finds its row.
      const byMac = data.macAddress
        ? await tx.interface.findFirst({
            where: {
              deviceId,
              deletedAt: null,
              macAddress: { equals: formatMacAddress(data.macAddress), mode: 'insensitive' },
              ...(byName ? { id: { not: byName.id } } : {}),
            },
            select: { id: true, name: true },
          })
        : null;

      let target = byName;
      if (byMac && !byName && !writtenIds.has(byMac.id)) {
        target = byMac; // the NIC was renamed since the row was written: live name wins
      } else if (byMac) {
        // The partial unique index (deviceId, lower(macAddress)) would abort the whole transaction.
        logger.warn(
          `Interfaces ${byMac.name} and ${data.name} on device ${deviceId} both report MAC ${data.macAddress} — storing ${data.name} without one`,
        );
        data.macAddress = null;
      }

      const row = target
        ? await tx.interface.update({ where: { id: target.id }, data, select: { id: true } })
        : await tx.interface.create({ data: { deviceId, ...data }, select: { id: true } });
      writtenIds.add(row.id);
      const interfaceId = row.id;

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
    const { written, removed } = await upsertPciDevices(tx, deviceId, upserts.pciDevices, pciDevicesPartial);
    counts.pciDevices = written;
    if (removed > 0) counts['pciDevices:removed'] = removed;
    if (pciDevicesPartial) counts['pciDevices:prune-skipped'] = 1;
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

/** Batched PciDevice upsert via raw SQL. Write every EXCLUDED column; prune stale `updatedAt` only when `rows` is the whole bus. */
async function upsertPciDevices(
  tx: Prisma.TransactionClient,
  deviceId: string,
  rows: PciDeviceUpsert[],
  partial: boolean,
): Promise<{ written: number; removed: number }> {
  // ON CONFLICT can't touch the same row twice in one statement; last wins.
  const deduped = [...new Map(rows.map((pci) => [pci.address, pci])).values()];
  const now = new Date();

  for (let i = 0; i < deduped.length; i += PCI_CHUNK) {
    const values = deduped.slice(i, i + PCI_CHUNK).map(
      (pci) => Prisma.sql`(
        ${randomUUID()}, ${deviceId}, ${pci.address}, ${pci.vendorId}, ${pci.vendorName ?? null},
        ${pci.productId}, ${pci.productName ?? null}, ${pci.className ?? null}, ${pci.subclassName ?? null},
        ${pci.driver ?? null}, ${pci.subsystemVendorId ?? null}, ${pci.subsystemProductId ?? null}, ${now}
      )`,
    );

    await tx.$executeRaw`
      INSERT INTO "PciDevice" (
        "id", "deviceId", "address", "vendorId", "vendorName", "productId", "productName",
        "className", "subclassName", "driver", "subsystemVendorId", "subsystemProductId", "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("deviceId", "address") DO UPDATE SET
        "vendorId"           = EXCLUDED."vendorId",
        "vendorName"         = EXCLUDED."vendorName",
        "productId"          = EXCLUDED."productId",
        "productName"        = EXCLUDED."productName",
        "className"          = EXCLUDED."className",
        "subclassName"       = EXCLUDED."subclassName",
        "driver"             = EXCLUDED."driver",
        "subsystemVendorId"  = EXCLUDED."subsystemVendorId",
        "subsystemProductId" = EXCLUDED."subsystemProductId",
        "updatedAt"          = EXCLUDED."updatedAt"
    `;
  }

  if (partial) return { written: deduped.length, removed: 0 };

  // devices that left the bus: card pulled, reseated, vfio renumbering
  const { count: removed } = await tx.pciDevice.deleteMany({
    where: { deviceId, updatedAt: { lt: now } },
  });

  return { written: deduped.length, removed };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_PRISMA_CODES.has(error.code)) return true;
    const meta = error.meta as { code?: string } | undefined;
    if (meta?.code && RETRYABLE_PG_CODES.has(meta.code)) return true;
  }
  return false;
}
