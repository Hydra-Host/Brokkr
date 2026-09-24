export type InstanceOperatorRecipientMember = {
  organizationId: string;
  user: { id: string };
};

export type FindInstanceOperatorMembers = (args: {
  where: { organization: { isInstanceOperator: true }; deletedAt: null };
  select: { organizationId: true; user: { select: { id: true } } };
}) => Promise<InstanceOperatorRecipientMember[]>;

export async function findInstanceOperatorRecipients(
  findMany: FindInstanceOperatorMembers,
): Promise<{ userIds: string[]; organizationId?: string }> {
  const members = await findMany({
    where: { organization: { isInstanceOperator: true }, deletedAt: null },
    select: { organizationId: true, user: { select: { id: true } } },
  });
  const userIds = [...new Set(members.map((m) => m.user.id))];
  const organizationId = members[0]?.organizationId;
  if (organizationId === undefined) {
    return { userIds };
  }
  return { userIds, organizationId };
}
