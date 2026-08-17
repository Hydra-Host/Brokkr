import type { ConsoleServerPort } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type ConsoleServerPortField = ModelFieldPaths<ConsoleServerPort>;

export const consoleServerPortPaginationConfig = createPaginationConfig<ConsoleServerPortField>({
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
