import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';

export async function assertParentDeviceReachable(deviceId: string, supplierId: string): Promise<void> {
  const client = ActiveRecordRegistry.client;
  const device = await client.device.findUnique({
    where: { id: deviceId, supplierId },
    select: { id: true },
  });
  if (!device) {
    throw new NotFoundException('Device not found');
  }
}

// Supplied (supplierId, servers) OR owned (organizationId, bridges — they carry no supplier). organizationId
// is denormalized from the zone operator, never a renter, so the owner arm does not widen access to renters.
export async function assertParentDeviceOwnedOrSupplied(deviceId: string, orgId: string): Promise<void> {
  const client = ActiveRecordRegistry.client;
  const device = await client.device.findUnique({
    where: { id: deviceId, deletedAt: null, OR: [{ supplierId: orgId }, { organizationId: orgId }] },
    select: { id: true },
  });
  if (!device) {
    throw new NotFoundException('Device not found');
  }
}
