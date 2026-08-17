import { IpStatus, Prisma } from '@repo/database';
import { isValidInetString } from './ensure-ip-address';

export type EnsureNatMappingOutcome = 'linked' | 'unchanged' | 'invalid' | 'inside-missing';

export interface EnsureNatMappingTx {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  ipAddress: {
    create(args: { data: Prisma.IpAddressUncheckedCreateInput }): Promise<unknown>;
    update(args: { where: { id: string }; data: Prisma.IpAddressUncheckedUpdateInput }): Promise<unknown>;
  };
}

/** Inside lookup is device-scoped (RFC1918 repeats across an org's devices); the outside row stays interface-unattached and only a standalone row is adopted — an attached/assigned public IP is never re-pointed. */
export async function ensureNatMapping(
  tx: EnsureNatMappingTx,
  params: { outsideAddress: string; insideAddress: string; organizationId: string; deviceId: string },
): Promise<EnsureNatMappingOutcome> {
  const { outsideAddress, insideAddress, organizationId, deviceId } = params;
  if (!isValidInetString(outsideAddress) || !isValidInetString(insideAddress)) return 'invalid';

  const insideRows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT ip.id FROM "IpAddress" ip
      JOIN "Interface" i ON i.id = ip."interfaceId"
      WHERE ip."organizationId" = ${organizationId}
        AND ip."deletedAt" IS NULL
        AND i."deviceId" = ${deviceId}
        AND host(ip.address) = host(${insideAddress}::inet)
      LIMIT 1
    `,
  );
  const insideId = insideRows[0]?.id;
  if (!insideId) return 'inside-missing';

  const outsideRows = await tx.$queryRaw<Array<{ id: string; natInsideId: string | null }>>(
    Prisma.sql`
      SELECT id, "natInsideId" FROM "IpAddress"
      WHERE "organizationId" = ${organizationId}
        AND "deletedAt" IS NULL
        AND "interfaceId" IS NULL
        AND "assignedObjectId" IS NULL
        AND host(address) = host(${outsideAddress}::inet)
      LIMIT 1
    `,
  );
  const existing = outsideRows[0];

  if (!existing) {
    await tx.ipAddress.create({
      data: { address: outsideAddress, status: IpStatus.ACTIVE, organizationId, natInsideId: insideId },
    });
    return 'linked';
  }

  if (existing.natInsideId === insideId) return 'unchanged';

  await tx.ipAddress.update({ where: { id: existing.id }, data: { natInsideId: insideId } });
  return 'linked';
}
