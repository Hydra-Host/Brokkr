import type { Invitation, OrganizationMemberRole } from '@repo/api-client';
import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface InvitationListItem {
  id: string;
  email: string;
  role: string;
  roleId: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationDetail {
  id: string;
  email: string;
  inviterId: string;
  organizationId: string;
  role: string;
  roleId: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
}

function mapInvitation(inv: Invitation): InvitationDetail {
  return {
    id: inv.id,
    email: inv.email,
    inviterId: inv.inviterId,
    organizationId: inv.organizationId,
    role: inv.role,
    roleId: inv.roleId,
    status: inv.status,
    createdAt: String(inv.createdAt),
    expiresAt: String(inv.expiresAt),
  };
}

function failFromResult(result: { status: number; body: unknown }, action: string): never {
  const message = (result.body as { message?: string } | null)?.message;
  throw new Error(message ?? `Failed to ${action} (${result.status})`);
}

export async function listInvitations(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string },
): Promise<{ data: InvitationListItem[]; meta: PaginationMeta }> {
  const result = await client.listInvitations({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
    },
  });

  if (result.status !== 200) {
    failFromResult(result, 'list invitations');
  }

  const data = result.body.data.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    roleId: inv.roleId,
    status: inv.status,
    createdAt: String(inv.createdAt),
    expiresAt: String(inv.expiresAt),
  }));

  return { data, meta: result.body.meta };
}

export async function createInvitation(
  client: CliApiClient,
  data: { email: string; roleId: string },
): Promise<InvitationDetail> {
  const result = await client.createInvitation({
    body: { email: data.email, roleId: data.roleId },
  });

  if (result.status !== 200) {
    failFromResult(result, 'send invitation');
  }

  return mapInvitation(result.body);
}

export async function listInvitationRoles(client: CliApiClient): Promise<OrganizationMemberRole[]> {
  const result = await client.listOrganizationRoles();
  if (result.status !== 200) {
    failFromResult(result, 'list organization roles');
  }
  return result.body;
}

export async function cancelInvitation(client: CliApiClient, invitationId: string): Promise<InvitationDetail> {
  const result = await client.cancelInvitation({
    params: { invitationId },
    body: {},
  });

  if (result.status === 404) {
    throw new Error(`Invitation not found: ${invitationId}`);
  }

  if (result.status !== 200) {
    failFromResult(result, 'cancel invitation');
  }

  return mapInvitation(result.body);
}

export async function getInvitation(client: CliApiClient, invitationId: string): Promise<InvitationDetail> {
  const result = await client.getInvitation({ params: { invitationId } });

  if (result.status === 404) {
    throw new Error(`Invitation not found: ${invitationId}`);
  }

  if (result.status !== 200) {
    failFromResult(result, 'get invitation');
  }

  return mapInvitation(result.body);
}
