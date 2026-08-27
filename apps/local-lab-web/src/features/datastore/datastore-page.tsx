import { TabBar } from '@/components/ui/tab-bar';
import { PostgresTab } from '@/features/datastore/postgres';
import { QueuesTab } from '@/features/datastore/queues';
import { RedisTab } from '@/features/datastore/redis';
import { useDatastoreSearch, useSelectDatastoreTab } from '@/features/datastore/shared';
import { ThanosTab } from '@/features/datastore/thanos';
import type { DatastoreTab } from '@/lib/datastore-search';

// ids are pinned to the union so a tab the route can render but not select cannot compile
export const TABS: readonly { id: DatastoreTab; label: string }[] = [
  { id: 'pg', label: 'Postgres' },
  { id: 'redis', label: 'Redis' },
  { id: 'thanos', label: 'Thanos' },
  { id: 'queues', label: 'Queues' },
];

export function DatastorePage() {
  const { tab } = useDatastoreSearch();
  const selectTab = useSelectDatastoreTab();
  return (
    <div className="space-y-5">
      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />
      {tab === 'redis' ? (
        <RedisTab />
      ) : tab === 'thanos' ? (
        <ThanosTab />
      ) : tab === 'queues' ? (
        <QueuesTab />
      ) : (
        <PostgresTab />
      )}
    </div>
  );
}
