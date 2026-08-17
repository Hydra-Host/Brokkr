import type { ConsolePort } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type ConsolePortField = ModelFieldPaths<ConsolePort>;

export const consolePortPaginationConfig = createPaginationConfig<ConsolePortField>({
  searchableFields: ['name', 'description'],
  filterFields: {
    deviceId: 'deviceId',
    type: 'type',
  },
  sortableFields: {
    name: 'name',
    type: 'type',
    speed: 'speed',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
