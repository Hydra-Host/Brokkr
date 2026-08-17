import type { FrontPort } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type FrontPortField = ModelFieldPaths<FrontPort>;

export const frontPortPaginationConfig = createPaginationConfig<FrontPortField>({
  searchableFields: ['name', 'description'],
  filterFields: {
    deviceId: 'deviceId',
    rearPortId: 'rearPortId',
    type: 'type',
  },
  sortableFields: {
    name: 'name',
    type: 'type',
    rearPortPosition: 'rearPortPosition',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
