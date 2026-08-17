import { AssignedObjectType, IpStatus, Prisma } from '@repo/database';
import { isIP } from 'node:net';

export type EnsureIpAddressOutcome = 'created' | 'attached' | 'unchanged' | 'invalid' | 'assigned-elsewhere';

export interface EnsureIpAddressTx {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  ipAddress: {
    create(args: { data: Prisma.IpAddressUncheckedCreateInput }): Promise<unknown>;
    update(args: { where: { id: string }; data: Prisma.IpAddressUncheckedUpdateInput }): Promise<unknown>;
  };
}

export function isValidInetString(address: string): boolean {
  const [host, mask, ...rest] = address.split('/');
  if (rest.length > 0 || !host) return false;
  const family = isIP(host);
  if (family === 0) return false;
  if (mask === undefined) return true;
  if (!/^\d{1,3}$/.test(mask)) return false;
  return parseInt(mask, 10) <= (family === 4 ? 32 : 128);
}

/** Lookup is by host part so mask variants don't duplicate; an IP attached to another device's interface is never stolen. */
export async function ensureIpAddress(
  tx: EnsureIpAddressTx,
  params: { address: string; interfaceId: string; deviceId: string; organizationId: string },
): Promise<EnsureIpAddressOutcome> {
  const { address, interfaceId, deviceId, organizationId } = params;
  if (!isValidInetString(address)) return 'invalid';

  const rows = await tx.$queryRaw<Array<{ id: string; interfaceId: string | null; deviceId: string | null }>>(
    Prisma.sql`
      SELECT ip.id, ip."interfaceId", i."deviceId"
      FROM "IpAddress" ip
      LEFT JOIN "Interface" i ON i.id = ip."interfaceId"
      WHERE ip."organizationId" = ${organizationId}
        AND ip."deletedAt" IS NULL
        AND host(ip.address) = host(${address}::inet)
      LIMIT 1
    `,
  );
  const existing = rows[0];

  if (!existing) {
    await tx.ipAddress.create({
      data: {
        address,
        status: IpStatus.ACTIVE,
        organizationId,
        interfaceId,
        assignedObjectType: AssignedObjectType.Interface,
        assignedObjectId: interfaceId,
      },
    });
    return 'created';
  }

  if (existing.interfaceId === interfaceId) return 'unchanged';
  if (existing.interfaceId !== null && existing.deviceId !== deviceId) return 'assigned-elsewhere';

  await tx.ipAddress.update({
    where: { id: existing.id },
    data: {
      interfaceId,
      assignedObjectType: AssignedObjectType.Interface,
      assignedObjectId: interfaceId,
    },
  });
  return 'attached';
}
