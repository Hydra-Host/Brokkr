import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { TabBar } from '@/components/ui/tab-bar';
import { LifecycleTab, TokensTab, WebhooksTab } from '@/features/hub';
import { type HubSearch, type HubTab, isHubTab, validateHubSearch } from '@/lib/hub-search';

// ids are pinned to the union so a tab the route can render but not select cannot compile
export const TABS: readonly { id: HubTab; label: string }[] = [
  { id: 'lifecycle', label: 'Lifecycle jobs' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'tokens', label: 'Device tokens' },
];

/** Takes search + setSearch as props rather than reaching for the router, so the whole route is
 *  renderable in a spec with no router mounted — the reason /datastore has no route spec. */
export function HubView({
  search,
  setSearch,
  nowMs,
}: {
  search: HubSearch;
  setSearch: (patch: Partial<HubSearch>) => void;
  nowMs?: number;
}) {
  const selectTab = (id: string) => {
    if (isHubTab(id)) setSearch({ tab: id });
  };

  return (
    <div className="space-y-5">
      <TabBar
        tabs={TABS}
        active={search.tab}
        onSelect={selectTab}
        trailing={<span className="text-text-dim ml-auto font-mono text-[11px]">read-only</span>}
      />
      {search.tab === 'webhooks' ? (
        <WebhooksTab search={search} setSearch={setSearch} nowMs={nowMs} />
      ) : search.tab === 'tokens' ? (
        <TokensTab search={search} setSearch={setSearch} nowMs={nowMs} />
      ) : (
        <LifecycleTab search={search} setSearch={setSearch} nowMs={nowMs} />
      )}
    </div>
  );
}

function HubPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/hub' });
  const setSearch = useCallback(
    (patch: Partial<HubSearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );
  return <HubView search={search} setSearch={setSearch} />;
}

export const Route = createFileRoute('/hub')({
  component: HubPage,
  validateSearch: validateHubSearch,
});
