import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { OutcomeBadge } from '~/components/event-log-badges';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import { actionDisplay, actorDisplay } from '~/lib/event-log';

export function DeviceSecretAccessFeed({ deviceId }: { deviceId: string }) {
  const { can } = usePermissions();
  const allowed = can('event-log', 'access');
  const query = tsr.listEventLog.useQuery({
    queryKey: ['device-secret-access-feed', deviceId],
    queryData: { query: { resource: 'device-secret', targetId: deviceId, pageSize: 20 } },
    enabled: allowed,
  });
  if (!allowed) return null;
  const entries = query.data?.status === 200 ? query.data.body.data : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Credential access</CardTitle>
        <CardDescription>Organization event log entries that name this device as their target.</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : query.isError ? (
          <p className="text-muted-foreground text-sm">The event log could not be loaded.</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">No credential access has been logged for this device.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const actor = actorDisplay(entry);
                const action = actionDisplay(entry);
                return (
                  <TableRow key={entry.id}>
                    <TableCell className="text-sm">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                    <TableCell className="text-sm">{action.verb}</TableCell>
                    <TableCell className="text-sm">
                      {actor.primary}
                      {actor.secondary && <span className="text-muted-foreground ml-1 text-xs">{actor.secondary}</span>}
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={entry.outcome} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
