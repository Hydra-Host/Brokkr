import { createFileRoute } from '@tanstack/react-router';

import { DatastorePage } from '@/features/datastore/datastore-page';
import { validateDatastoreSearch } from '@/lib/datastore-search';

export const Route = createFileRoute('/datastore')({
  component: DatastorePage,
  validateSearch: validateDatastoreSearch,
});
