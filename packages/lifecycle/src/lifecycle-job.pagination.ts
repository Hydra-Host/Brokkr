import type { LifecycleJob } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type LifecycleJobField = ModelFieldPaths<LifecycleJob>;

export const lifecycleJobPaginationConfig = createPaginationConfig<LifecycleJobField>({
  searchableFields: ['id'],
  filterFields: {},
  sortableFields: {
    createdAt: 'createdAt',
    jobType: 'jobType',
    phase: 'phase',
    id: 'id',
  },
  defaultSort: [
    { field: 'createdAt', direction: 'desc' },
    { field: 'id', direction: 'desc' },
  ],
});
