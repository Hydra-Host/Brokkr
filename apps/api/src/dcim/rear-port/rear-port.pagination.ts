import type { RearPort } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type RearPortField = ModelFieldPaths<RearPort>;

export const rearPortPaginationConfig = createPaginationConfig<RearPortField>({
  searchableFields: ['name', 'description'],
  filterFields: {
    deviceId: 'deviceId',
    type: 'type',
  },
  sortableFields: {
    name: 'name',
    type: 'type',
    positions: 'positions',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
