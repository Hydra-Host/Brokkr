import type { Cable } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type CableField = ModelFieldPaths<Cable>;

export const cablePaginationConfig = createPaginationConfig<CableField>({
  searchableFields: ['label', 'description'],
  filterFields: {
    status: 'status',
    type: 'type',
  },
  sortableFields: {
    label: 'label',
    status: 'status',
    type: 'type',
    length: 'length',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'createdAt', direction: 'desc' }],
  defaultPageSize: 50,
});
