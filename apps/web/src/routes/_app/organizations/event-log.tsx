import type { EventLogEntry, EventLogQuery } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Label } from '@repo/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@repo/ui/components/sheet';
import { Switch } from '@repo/ui/components/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/components/tooltip';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { formatShortDateTime } from '@repo/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Eye, Info, ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BootScreen } from '~/components/boot-screen';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import { actionDisplay, actorDisplay } from '~/lib/event-log';

export const Route = createFileRoute('/_app/organizations/event-log')({
  staticData: { breadcrumb: 'Event Log', description: 'Review actions taken by members of your organization' },
  component: EventLogPage,
});

const ANY = 'any';

const OUTCOMES = ['SUCCEEDED', 'FAILED', 'DENIED'] as const;
const TIERS = ['EVIDENCE', 'ACTIVITY'] as const;

const toOutcome = (value: string) => OUTCOMES.find((outcome) => outcome === value);
const toTier = (value: string) => TIERS.find((tier) => tier === value);

function OutcomeBadge({ outcome }: { outcome: EventLogEntry['outcome'] }) {
  switch (outcome) {
    case 'SUCCEEDED':
      return (
        <Badge variant="outline" className="border-status-online text-status-online">
          Succeeded
        </Badge>
      );
    case 'DENIED':
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-500">
          Denied
        </Badge>
      );
    case 'FAILED':
      return <Badge variant="destructive">Failed</Badge>;
  }
}

/** ATOMIC rows shared the mutation's transaction; the rest can be missing after a crash, so the
 *  distinction is surfaced rather than hidden behind a uniform-looking feed. */
function DurabilityBadge({ entry }: { entry: EventLogEntry }) {
  if (entry.durability === 'ATOMIC') {
    return <Badge variant="secondary">Evidence</Badge>;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {entry.tier === 'EVIDENCE' ? 'Evidence (best effort)' : 'Activity'}
    </Badge>
  );
}

function RecordHeader() {
  return (
    <div className="flex items-center gap-1">
      <span>Record</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger aria-label="What the record types mean">
            <Info className="text-muted-foreground h-3.5 w-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">How reliably this event was recorded.</p>
            <p className="mt-2">
              <span className="font-medium">Evidence</span> — written inside the action&apos;s own database transaction.
              If the action happened, the record exists.
            </p>
            <p className="mt-1">
              <span className="font-medium">Evidence (best effort)</span> — a governance action, but recorded after the
              fact. A crash in between can lose the record while the action stands.
            </p>
            <p className="mt-1">
              <span className="font-medium">Activity</span> — captured automatically and never allowed to delay a
              request, so a failure to record it is logged and dropped.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <code className="max-w-[260px] truncate text-right text-xs">{value}</code>
    </div>
  );
}

const columns: ServerColumnDef<EventLogEntry>[] = [
  {
    accessorKey: 'createdAt',
    header: 'Time',
    sortField: 'createdAt',
    size: 170,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">{formatShortDateTime(row.original.createdAt)}</span>
    ),
  },
  {
    accessorKey: 'actorLabel',
    header: 'Actor',
    enableSorting: false,
    cell: ({ row }) => {
      const actor = actorDisplay(row.original);
      return (
        <div className="flex flex-col overflow-hidden">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{actor.primary}</span>
            <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
              {row.original.actorType}
            </Badge>
          </div>
          {actor.secondary && <span className="text-muted-foreground truncate text-xs">via {actor.secondary}</span>}
        </div>
      );
    },
  },
  {
    accessorKey: 'actionKey',
    header: 'Action',
    sortField: 'actionKey',
    cell: ({ row }) => {
      const action = actionDisplay(row.original);
      return (
        <div className="flex flex-col overflow-hidden">
          <span className="truncate font-medium">{action.verb}</span>
          <span className="text-muted-foreground truncate text-xs">{action.resource}</span>
        </div>
      );
    },
  },
  {
    accessorKey: 'targetLabel',
    header: 'Target',
    enableSorting: false,
    breakpoint: 'tablet',
    cell: ({ row }) => {
      const { targetLabel, targetId } = row.original;
      if (!targetLabel && !targetId) return <span className="text-muted-foreground text-sm">—</span>;
      return <span className="truncate text-sm">{targetLabel ?? targetId}</span>;
    },
  },
  {
    accessorKey: 'outcome',
    header: 'Outcome',
    enableSorting: false,
    size: 120,
    cell: ({ row }) => <OutcomeBadge outcome={row.original.outcome} />,
  },
  {
    accessorKey: 'durability',
    header: () => <RecordHeader />,
    enableSorting: false,
    breakpoint: 'desktop',
    size: 150,
    cell: ({ row }) => <DurabilityBadge entry={row.original} />,
  },
];

function EventLogPage() {
  useDocumentTitle('Event Log');

  const { can, isLoading: isLoadingPermissions } = usePermissions();
  const canAccess = can('event-log', 'access');

  const [selected, setSelected] = useState<EventLogEntry | null>(null);
  const [includeSystemActors, setIncludeSystemActors] = useState(false);
  const [outcome, setOutcome] = useState<EventLogEntry['outcome'] | undefined>(undefined);
  const [tier, setTier] = useState<EventLogEntry['tier'] | undefined>(undefined);

  const tableColumns = useMemo(
    () => [
      ...columns,
      {
        id: 'actions',
        size: 48,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSelected(row.original)}
              title="View details"
            >
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        ),
      } satisfies ServerColumnDef<EventLogEntry>,
    ],
    [],
  );

  const table = useServerTable<EventLogEntry>({ name: 'org-event-log', columns: tableColumns });

  const query: EventLogQuery = {
    ...table.query,
    ...(includeSystemActors ? { includeSystemActors: true } : {}),
    ...(outcome ? { outcome } : {}),
    ...(tier ? { tier } : {}),
  };
  const hasFilters = includeSystemActors || !!outcome || !!tier || !!table.search;

  const {
    data: response,
    isPending,
    isFetching,
  } = tsr.listEventLog.useQuery({
    queryKey: ['event-log', query],
    queryData: { query },
    placeholderData: keepPreviousData,
    enabled: canAccess,
  });

  const entries = response?.status === 200 ? response.body.data : [];
  const meta = response?.status === 200 ? response.body.meta : undefined;

  // Resetting to the first page keeps a narrowed result set from landing on a page that no longer exists.
  const applyFilter = (apply: () => void) => {
    apply();
    table.setPage(1);
  };

  if (isLoadingPermissions) return <BootScreen />;

  if (!canAccess) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Event Log</CardTitle>
          <CardDescription>You do not have permission to view this organization&apos;s event log.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-4">
      <Select value={outcome ?? ANY} onValueChange={(value) => applyFilter(() => setOutcome(toOutcome(value)))}>
        <SelectTrigger className="w-[150px]" aria-label="Filter by outcome">
          <SelectValue placeholder="Outcome" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any outcome</SelectItem>
          <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
          <SelectItem value="FAILED">Failed</SelectItem>
          <SelectItem value="DENIED">Denied</SelectItem>
        </SelectContent>
      </Select>

      <Select value={tier ?? ANY} onValueChange={(value) => applyFilter(() => setTier(toTier(value)))}>
        <SelectTrigger className="w-[170px]" aria-label="Filter by record type">
          <SelectValue placeholder="Record type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All records</SelectItem>
          <SelectItem value="EVIDENCE">Governance actions</SelectItem>
          <SelectItem value="ACTIVITY">Other activity</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex items-center gap-2">
        <Switch
          id="include-system-actors"
          checked={includeSystemActors}
          onCheckedChange={(checked) => applyFilter(() => setIncludeSystemActors(checked))}
        />
        <Label htmlFor="include-system-actors" className="text-muted-foreground text-sm font-normal">
          Include system activity
        </Label>
      </div>
    </div>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Event Log</CardTitle>
          <CardDescription>
            Actions taken by members, API keys, and integrations in your organization. Automated device and system
            activity is hidden unless you ask for it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <BootScreen />
          ) : !isFetching && meta?.totalItems === 0 && !hasFilters ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ScrollText className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="text-lg font-medium">No events yet</h3>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                Actions taken by your organization&apos;s members will appear here as they happen.
              </p>
            </div>
          ) : (
            <ServerDataTable
              table={table}
              data={entries}
              meta={meta}
              isPending={isPending}
              isFetching={isFetching && !isPending}
              toolbar={toolbar}
              searchPlaceholder="Search actions, actors, targets..."
              searchLabel="Search the event log"
              emptyMessage="No events recorded yet"
            />
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Event Details</SheetTitle>
            <SheetDescription>
              {selected ? `${actionDisplay(selected).verb} · ${formatShortDateTime(selected.createdAt)}` : ''}
            </SheetDescription>
          </SheetHeader>

          {selected && (
            <div className="mt-6 space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <OutcomeBadge outcome={selected.outcome} />
                <DurabilityBadge entry={selected} />
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Event</h4>
                <div className="bg-muted space-y-2 rounded-md p-3 text-sm">
                  <DetailRow label="Event ID" value={selected.id} />
                  <DetailRow label="Action" value={selected.actionKey} />
                  <DetailRow label="Target" value={selected.targetLabel} />
                  <DetailRow label="Target ID" value={selected.targetId} />
                  <DetailRow label="Error" value={selected.errorCode} />
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Actor</h4>
                <div className="bg-muted space-y-2 rounded-md p-3 text-sm">
                  <DetailRow label="Type" value={selected.actorType} />
                  <DetailRow label="Name" value={selected.actorLabel} />
                  <DetailRow label="User ID" value={selected.actorId} />
                  <DetailRow label="API key" value={selected.apiKeyLabel} />
                  <DetailRow label="API key ID" value={selected.apiKeyId} />
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Request</h4>
                <div className="bg-muted space-y-2 rounded-md p-3 text-sm">
                  <DetailRow label="Request ID" value={selected.requestId} />
                  <DetailRow label="Method" value={selected.method} />
                  <DetailRow label="Path" value={selected.path} />
                  <DetailRow label="IP address" value={selected.ipAddress} />
                  <DetailRow label="User agent" value={selected.userAgent} />
                </div>
              </div>

              {selected.metadata && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Details</h4>
                  <pre className="bg-muted max-h-[300px] overflow-auto rounded-md p-3 text-xs">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
