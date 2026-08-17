import type { PaginationConfig } from '@repo/database/pagination';

export const zonesPaginationConfig: PaginationConfig = {
  searchableFields: ['name'],
  filterFields: {},
  sortableFields: {
    name: 'name',
    createdAt: 'createdAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
};
