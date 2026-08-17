import type { Invitation, OrganizationMemberRole } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type InvitationField = ModelFieldPaths<Invitation, { assignedRole: OrganizationMemberRole }>;

export const invitationsPaginationConfig = createPaginationConfig<InvitationField>({
  searchableFields: ['email', 'assignedRole.name'],
  filterFields: {
    status: 'status',
    role: 'assignedRole.slug',
  },
  sortableFields: {
    email: 'email',
    role: 'assignedRole.name',
    status: 'status',
    createdAt: 'createdAt',
    expiresAt: 'expiresAt',
  },
  defaultSort: [{ field: 'createdAt', direction: 'desc' }],
});
