import type { LifecycleJobEvent } from '@repo/api-client';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { isForbiddenError } from '../hooks/api-errors';
import { OPEN_JOB_POLL_MS } from '../hooks/poll-intervals';
import { diagnosticsKeys, useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { useCanViewJobHistory } from './job-history-columns';
import { SagaStepTimeline } from './saga-step-timeline';

export const RECORDED_SAGAS_NOTE =
  'Step events are recorded for provision, reprovision, power, deprovision, inventory and benchmark jobs. Commissioning steps are on the zone commissioning page.';

const NO_ACCESS_MESSAGE = 'You do not have access to job events.';

export function recoveryNotes(events: LifecycleJobEvent[]): string[] {
  const notes: string[] = [];
  const retries = new Map<string, { label: string; attempt: number }>();
  for (const event of events) {
    if (event.attempt === 0) continue;
    const previous = retries.get(event.stepName);
    retries.set(event.stepName, {
      label: event.operation ?? event.stepName,
      attempt: Math.max(previous?.attempt ?? 0, event.attempt),
    });
  }
  for (const { label, attempt } of retries.values()) {
    notes.push(`The bridge retried ${label} ${attempt} ${attempt === 1 ? 'time' : 'times'}.`);
  }
  for (const event of events) {
    if (event.origin === 'hub' && event.status === 'failed') {
      notes.push(
        `The hub ${event.eventType.replace(/_/g, ' ')} failed the job: ${event.error ?? 'no detail recorded'}.`,
      );
    }
    if (event.stepName === 'ipxe_chainload' && event.status === 'failed') {
      notes.push(`iPXE gave up chainloading: ${event.error ?? 'no detail recorded'}.`);
    }
  }
  return notes;
}

export function JobStepsPane({ jobId, inFlight }: { jobId: string; inFlight: boolean }) {
  const api = useDiagnosticsApi();
  const { canView, isPending: gatePending } = useCanViewJobHistory();
  const query = useQuery({
    queryKey: diagnosticsKeys.jobEvents(jobId),
    queryFn: () => api.jobEvents(jobId),
    enabled: canView,
    refetchInterval: inFlight ? OPEN_JOB_POLL_MS : false,
  });
  const body = query.data ?? null;

  if (!gatePending && !canView) {
    return <p className="text-muted-foreground text-sm">{NO_ACCESS_MESSAGE}</p>;
  }
  if (gatePending || query.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        {isForbiddenError(query.error) ? NO_ACCESS_MESSAGE : 'Job events could not be loaded.'}
      </p>
    );
  }
  if (body === null || body.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No step events were recorded for this job. {RECORDED_SAGAS_NOTE}</p>
    );
  }

  const notes = recoveryNotes(body.data);

  return (
    <div className="space-y-4">
      {notes.length > 0 && (
        <section>
          <h4 className="mb-1 text-sm font-medium">Recovery</h4>
          <ul className="text-muted-foreground list-disc pl-5 text-sm">
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      <SagaStepTimeline events={body.data} truncated={body.meta.truncated} cap={body.meta.cap} />
    </div>
  );
}
