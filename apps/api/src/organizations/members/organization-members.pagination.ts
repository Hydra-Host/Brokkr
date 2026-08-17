import type { Member, User } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type MemberField = ModelFieldPaths<Member, { user: User }>;

export const membersPaginationConfig = createPaginationConfig<MemberField>({
  searchableFields: ['user.name', 'user.email'],
  filterFields: {
    role: 'role',
    assignedRoleId: 'assignedRoleId',
  },
  sortableFields: {
    role: 'role',
    name: 'user.name',
    email: 'user.email',
    createdAt: 'createdAt',
  },
  defaultSort: [
    { field: 'role', direction: 'asc' },
    { field: 'name', direction: 'asc' },
  ],
});
