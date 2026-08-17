import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from 'src/prisma/prisma.client';

export async function requireZoneOwnership(
  prisma: PrismaClient,
  zoneId: string,
  organizationId: string,
): Promise<{ id: string; organizationId: string }> {
  const zone = await prisma.zone.findUnique({
    where: { id: zoneId },
    select: { id: true, organizationId: true, deletedAt: true },
  });
  if (!zone || zone.deletedAt || zone.organizationId !== organizationId) {
    throw new NotFoundException('Zone not found');
  }
  return zone;
}
