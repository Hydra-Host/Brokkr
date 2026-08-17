import { DeviceRole } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';

export type BridgeZoneAdapterRow = {
  id: string;
  display: string;
};

export async function getBridgesInZoneFromPrisma(
  prisma: PrismaClient,
  zoneId: string,
): Promise<BridgeZoneAdapterRow[]> {
  const bridges = await prisma.device.findMany({
    where: { zoneId, role: DeviceRole.Bridge, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return bridges.map((b) => ({ id: b.id, display: b.name }));
}
