import type { Device } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type PduField = ModelFieldPaths<Device>;

export const pduPaginationConfig = createPaginationConfig<PduField>({
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
