import { OrganizationMembershipRoleSchema } from '@repo/api-client';
import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface MemberListItem {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: string;
}

function mapMember(m: {
  id: string;
  userId: string;
  user: { name: string | null; email: string };
  role: string;
  createdAt: Date;
}): MemberListItem {
  return {
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    createdAt: String(m.createdAt),
  };
}

export interface MemberDetail {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export async function listMembers(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string; role?: string },
): Promise<{ data: MemberListItem[]; meta: PaginationMeta }> {
  const result = await client.getOrganizationMemberships({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.role ? { role: OrganizationMembershipRoleSchema.parse(query.role) } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list members (${result.status})`);
  }

  return { data: result.body.data.map(mapMember), meta: result.body.meta };
}

export async function getMember(client: CliApiClient, memberId: string): Promise<MemberDetail> {
  const result = await client.getOrganizationMember({ params: { memberId } });

  if (result.status === 404) {
    throw new Error(`Member not found: ${memberId}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get member (${result.status})`);
  }

  const m = result.body;
  return {
    id: m.id,
    userId: m.userId,
    organizationId: m.organizationId,
    role: m.role,
    createdAt: String(m.createdAt),
    updatedAt: String(m.updatedAt),
    deletedAt: m.deletedAt ? String(m.deletedAt) : null,
  };
}

export async function updateMemberRole(client: CliApiClient, memberId: string, role: string): Promise<MemberListItem> {
  const result = await client.updateOrganizationMemberRole({
    params: { memberId },
    body: { role: OrganizationMembershipRoleSchema.parse(role) },
  });

  if (result.status === 404) {
    throw new Error(`Member not found: ${memberId}`);
  }

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to update member role (${result.status})`);
  }

  return mapMember(result.body);
}

export async function removeMember(client: CliApiClient, membershipId: string): Promise<MemberListItem> {
  const result = await client.deleteOrganizationMembership({
    params: { membershipId },
  });

  if (result.status === 404) {
    throw new Error(`Member not found: ${membershipId}`);
  }

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to remove member (${result.status})`);
  }

  return mapMember(result.body);
}
