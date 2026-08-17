import type { EventLog } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type EventLogField = ModelFieldPaths<EventLog>;

export const eventLogPaginationConfig = createPaginationConfig<EventLogField>({
  searchableFields: ['actionKey', 'actorLabel', 'targetLabel'],
  // Empty on purpose: the service composes the where itself. Delegating here would append
  // actorType under AND, contradicting the top-level `notIn` default and matching nothing.
  filterFields: {},
  sortableFields: {
    createdAt: 'createdAt',
    actionKey: 'actionKey',
    id: 'id',
  },
  // The helper appends only these tie-breakers and assumes they end in a unique key — it does not
  // inject `id`, and without it offset pages skip and duplicate rows whenever timestamps tie.
  defaultSort: [
    { field: 'createdAt', direction: 'desc' },
    { field: 'id', direction: 'desc' },
  ],
});
