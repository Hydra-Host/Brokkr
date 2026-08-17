import type { Rack } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type RackField = ModelFieldPaths<Rack>;

export const rackPaginationConfig = createPaginationConfig<RackField>({
  searchableFields: ['name', 'description', 'serial', 'assetTag'],
  filterFields: {
    zoneId: 'zoneId',
    status: 'status',
    role: 'role',
    organizationId: 'organizationId',
  },
  sortableFields: {
    name: 'name',
    status: 'status',
    role: 'role',
    heightU: 'heightU',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
