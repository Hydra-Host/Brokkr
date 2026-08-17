import type { PowerOutlet } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type PowerOutletField = ModelFieldPaths<PowerOutlet>;

export const powerOutletPaginationConfig = createPaginationConfig<PowerOutletField>({
  searchableFields: ['name', 'description'],
  filterFields: {
    deviceId: 'deviceId',
    type: 'type',
    feedLegPhase: 'feedLegPhase',
  },
  sortableFields: {
    name: 'name',
    type: 'type',
    feedLegPhase: 'feedLegPhase',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
