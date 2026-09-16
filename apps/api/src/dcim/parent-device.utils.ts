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

export async function assertParentDeviceOwnedOrSupplied(deviceId: string, orgId: string): Promise<void> {
  const client = ActiveRecordRegistry.client;
  const device = await client.device.findUnique({
    where: { id: deviceId, deletedAt: null, supplierId: orgId },
    select: { id: true },
  });
  if (!device) {
    throw new NotFoundException('Device not found');
  }
}
