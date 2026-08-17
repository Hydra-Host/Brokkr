import type { CloudInitTemplate } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type CloudInitTemplateField = ModelFieldPaths<CloudInitTemplate>;

export const cloudInitTemplatesPaginationConfig = createPaginationConfig<CloudInitTemplateField>({
  searchableFields: ['name', 'content'],
  filterFields: {},
  sortableFields: {
    name: 'name',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'createdAt', direction: 'desc' }],
});
