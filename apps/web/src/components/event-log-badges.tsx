import type { EventLogEntry } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';

export function OutcomeBadge({ outcome }: { outcome: EventLogEntry['outcome'] }) {
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
export function DurabilityBadge({ entry }: { entry: EventLogEntry }) {
  if (entry.durability === 'ATOMIC') {
    return <Badge variant="secondary">Evidence</Badge>;
  }
  if (entry.durability === 'MIRROR') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Mirrored
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {entry.tier === 'EVIDENCE' ? 'Evidence (best effort)' : 'Activity'}
    </Badge>
  );
}
