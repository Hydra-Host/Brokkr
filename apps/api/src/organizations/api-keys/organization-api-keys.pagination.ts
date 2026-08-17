import type { ApiKey, User } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type ApiKeyField = ModelFieldPaths<ApiKey, { user: User }>;

export const apiKeysPaginationConfig = createPaginationConfig<ApiKeyField>({
  searchableFields: ['name', 'user.email', 'user.name'],
  filterFields: {
    createdByEmail: 'user.email',
  },
  sortableFields: {
    name: 'name',
    createdAt: 'createdAt',
    expiresAt: 'expiresAt',
  },
  defaultSort: [{ field: 'createdAt', direction: 'desc' }],
});
