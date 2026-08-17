import { PrismaClient } from 'src/prisma/prisma.client';

export async function resolveLocationEastWestNetworkType(
  prisma: PrismaClient,
  zoneId: string | null,
): Promise<string | null> {
  if (zoneId == null) return null;
  const zone = await prisma.zone.findUnique({
    where: { id: zoneId, deletedAt: null },
    select: { eastWestNetworkType: true },
  });
  if (!zone?.eastWestNetworkType) return null;
  return zone.eastWestNetworkType.toLowerCase();
}
