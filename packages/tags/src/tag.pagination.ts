import type { Tag } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type TagField = ModelFieldPaths<Tag>;

export const tagsPaginationConfig = createPaginationConfig<TagField>({
  searchableFields: ['name', 'slug', 'description'],
  filterFields: {},
  sortableFields: {
    name: 'name',
    slug: 'slug',
    createdAt: 'createdAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
});
