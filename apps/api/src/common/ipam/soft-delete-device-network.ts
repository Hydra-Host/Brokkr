import { Prisma } from '@repo/database';
import { DeviceSecretActor } from 'src/device-secret/device-secret-audit.service';
import { DeviceSecretService } from 'src/device-secret/device-secret.service';

export async function softDeleteDeviceNetworkAndSecrets(
  tx: Prisma.TransactionClient,
  deviceSecretService: DeviceSecretService,
  deviceId: string,
  actor: DeviceSecretActor,
  cause: string,
  now: Date,
): Promise<void> {
  const ifaces = await tx.interface.findMany({ where: { deviceId, deletedAt: null }, select: { id: true } });
  const ifaceIds = ifaces.map((i) => i.id);
  if (ifaceIds.length > 0) {
    await tx.ipAddress.updateMany({
      where: { interfaceId: { in: ifaceIds }, deletedAt: null },
      data: { deletedAt: now },
    });
  }
  await tx.interface.updateMany({ where: { deviceId, deletedAt: null }, data: { deletedAt: now } });
  await deviceSecretService.invalidateAll(deviceId, actor, cause, tx);
}
