import type { PowerPort } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type PowerPortField = ModelFieldPaths<PowerPort>;

export const powerPortPaginationConfig = createPaginationConfig<PowerPortField>({
  searchableFields: ['name', 'description'],
  filterFields: {
    deviceId: 'deviceId',
    type: 'type',
  },
  sortableFields: {
    name: 'name',
    type: 'type',
    maximumDraw: 'maximumDraw',
    allocatedDraw: 'allocatedDraw',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
