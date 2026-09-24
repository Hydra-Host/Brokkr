export type ZoneSupplierDeviceRow = {
  supplierId: string | null;
};

export type FindZoneSupplierDevices = (args: {
  where: { zoneId: string; deletedAt: null; supplierId: { not: null } };
  select: { supplierId: true };
  distinct: ['supplierId'];
}) => Promise<ZoneSupplierDeviceRow[]>;

export type ZoneSupplierMemberRow = {
  organizationId: string;
  user: { id: string };
};

export type FindZoneSupplierMembers = (args: {
  where: { organizationId: { in: string[] }; deletedAt: null };
  select: { organizationId: true; user: { select: { id: true } } };
}) => Promise<ZoneSupplierMemberRow[]>;

export async function findZoneSupplierRecipients(
  zoneId: string,
  findDevices: FindZoneSupplierDevices,
  findMembers: FindZoneSupplierMembers,
): Promise<{ userIds: string[]; organizationId?: string }> {
  const devices = await findDevices({
    where: { zoneId, deletedAt: null, supplierId: { not: null } },
    select: { supplierId: true },
    distinct: ['supplierId'],
  });
  const supplierIds = [...new Set(devices.flatMap((row) => (row.supplierId != null ? [row.supplierId] : [])))];
  if (supplierIds.length === 0) {
    return { userIds: [] };
  }

  const members = await findMembers({
    where: { organizationId: { in: supplierIds }, deletedAt: null },
    select: { organizationId: true, user: { select: { id: true } } },
  });
  const userIds = [...new Set(members.map((m) => m.user.id))];
  const organizationId = supplierIds.length === 1 ? supplierIds[0] : undefined;
  if (organizationId === undefined) {
    return { userIds };
  }
  return { userIds, organizationId };
}
