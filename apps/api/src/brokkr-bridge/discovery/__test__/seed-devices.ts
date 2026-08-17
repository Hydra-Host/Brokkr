import type { PrismaClient as ImportedPrismaClient } from '@repo/database';

export async function seedDevices(prisma: ImportedPrismaClient, deviceIds: string[]): Promise<void> {
  for (const id of deviceIds) {
    await prisma.device.upsert({
      where: { id },
      update: {},
      create: {
        id,
        name: `prod-sample-${id}`,
      },
    });
  }
}

export async function cleanupSeededDevices(prisma: ImportedPrismaClient, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;

  await prisma.$transaction([
    prisma.discoveryRunIssue.deleteMany({ where: { run: { deviceId: { in: deviceIds } } } }),
    prisma.discoveryRun.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.pciDevice.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.uefiBootEntry.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.nvlinkEdge.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.deviceSolConfig.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.deviceFirmware.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.memoryConfig.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.storageDrive.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.cpu.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.gpu.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.interface.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.server.deleteMany({ where: { deviceId: { in: deviceIds } } }),
    prisma.device.deleteMany({ where: { id: { in: deviceIds } } }),
  ]);
}
