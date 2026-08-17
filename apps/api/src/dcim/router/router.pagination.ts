import type { Device } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type RouterField = ModelFieldPaths<Device>;

export const routerPaginationConfig = createPaginationConfig<RouterField>({
  searchableFields: ['name', 'nickname'],
  filterFields: { status: 'status' },
  sortableFields: {
    name: 'name',
    status: 'status',
    createdAt: 'createdAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
