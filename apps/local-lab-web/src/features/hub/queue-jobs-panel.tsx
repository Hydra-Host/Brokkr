import { Link } from '@tanstack/react-router';

import type { LifecycleJobRow, LifecycleQueueJoin } from '@/contract';
import { stateTone } from '@/features/datastore/queues/queue-health';
import { ErrorBanner } from '@/features/datastore/shared/error-banner';
import { queueJobSearch } from '@/lib/datastore-search';
import { fmtAgo } from '@/lib/format';

import { useLifecycleQueueJobs } from './use-hub';

/** A finished job is trimmed by the queue's keep-completed policy, so "gone" and "never there" are
 *  different answers and only the phase distinguishes them. */
function EmptyNote({ job, join }: { job: LifecycleJobRow; join: LifecycleQueueJoin }) {
  const terminal = job.phase === 'COMPLETED' || job.phase === 'FAILED' || job.phase === 'ABORTED';
  // an incomplete search cannot assert none: the banners above say why, and this must not contradict them
  if (join.readError !== null || join.discoveryCapped) {
    return <span className="text-text-dim">none found, but the search above was incomplete</span>;
  }
  if (join.searchedQueues.length === 0) {
    return <span className="text-text-dim">no saga queue exists yet to search</span>;
  }
  return (
    <span className="text-text-dim">
      {terminal
        ? 'no queue job left — a finished job is trimmed by the queue’s keep-completed policy'
        : 'no queue job carries this plan id'}
    </span>
  );
}

export function QueueJobsPanel({ job, nowMs }: { job: LifecycleJobRow; nowMs: number }) {
  const { join, error, isPending } = useLifecycleQueueJobs(job.id);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (isPending || !join) return <div className="text-text-dim text-xs">loading…</div>;

  if (!join.joinable) {
    return (
      <div className="text-text-dim font-mono text-[11px]" title="this is undetermined, not a measurement of none">
        cannot be joined — {join.unjoinableReason}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {join.readError && <ErrorBanner>a queue could not be read — {join.readError}</ErrorBanner>}
      {join.discoveryCapped && (
        <div
          className="text-status-warning text-[11px]"
          title="a queue's id discovery hit its scan cap, so jobs beyond it were never examined"
        >
          the search was capped — this list may be short
        </div>
      )}

      {join.matches.length === 0 ? (
        <div className="font-mono text-[11px]">
          <EmptyNote job={job} join={join} />
        </div>
      ) : (
        join.matches.map(({ queue, job: queueJob }) => (
          <div
            key={`${queue.prefix}/${queue.name}/${queueJob.id}`}
            className="border-border-dim bg-bg-secondary rounded-lg border px-2 py-1.5 font-mono text-[11px]"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className={stateTone(queueJob.state)}>{queueJob.state}</span>
              <span className="text-text-primary">{queueJob.sagaName ?? queueJob.name}</span>
              {queueJob.sealed && (
                <span className="text-status-info/70 text-[10px]" title="sealed zone envelope">
                  sealed
                </span>
              )}
              <Link
                to="/datastore"
                search={(prev) => queueJobSearch(prev, queue.prefix, queue.name, queueJob.id)}
                title="open this job in the queue inspector, where it can be retried or removed"
                className="border-accent/30 text-accent hover:bg-accent/10 ml-auto shrink-0 rounded border px-1 text-[10px]"
              >
                open
              </Link>
            </div>
            <div className="text-text-dim mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[10px]">
              <span>{queue.name}</span>
              <span className={queueJob.attemptsMade > 0 ? 'text-status-warning/80' : ''}>
                {queueJob.attemptsMade} att
              </span>
              {queueJob.finishedOn !== null ? (
                <span>finished {fmtAgo(queueJob.finishedOn, nowMs)}</span>
              ) : queueJob.processedOn !== null ? (
                <span>started {fmtAgo(queueJob.processedOn, nowMs)}</span>
              ) : (
                <span>not started</span>
              )}
            </div>
            {queueJob.failedReason && (
              <div className="text-status-offline mt-0.5 text-[10px] break-words">{queueJob.failedReason}</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
