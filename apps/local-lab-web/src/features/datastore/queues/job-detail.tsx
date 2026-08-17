import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { GateModal, SvcBtn } from '@/components/console';
import type { QueueJobDetail } from '@/contract';
import { Cell, CopyButton, ErrorBanner, Tile, errText, useSetDatastoreSearch } from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import { jobLifecycleSearch } from '@/lib/hub-search';

import { durationLabel, epochLabel, stateTone, type QueueAddress } from './queue-health';
import { useQueueMutations } from './use-queue-mutations';

export function JobDetailPanel({
  queue,
  jobId,
  onChanged,
}: {
  queue: QueueAddress;
  jobId: string;
  onChanged: () => void;
}) {
  const q = tsr.getQueueJob.useQuery({
    queryKey: ['queue-job', queue.prefix, queue.name, jobId],
    // ts-rest interpolates path params raw, and bullmq constrains a custom job id to nothing at all
    queryData: {
      params: {
        prefix: encodeURIComponent(queue.prefix),
        name: encodeURIComponent(queue.name),
        jobId: encodeURIComponent(jobId),
      },
    },
  });
  const setSearch = useSetDatastoreSearch();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { retryJob, removeJob, retryBusy, removeBusy } = useQueueMutations(onChanged);
  const body = q.data?.status === 200 ? q.data.body : null;
  const err = errText(q.data, q.error);

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!body) return <div className="text-text-dim text-sm">loading…</div>;

  const onRetry = () => {
    if (body.state !== 'failed' && body.state !== 'completed') return;
    retryJob({ queue, jobId }, body.state, () => void q.refetch());
  };

  return (
    <>
      {confirmRemove && (
        <GateModal
          fixed
          gate={{
            label: `Remove job ${jobId}`,
            destructive: true,
            description: (
              <>
                Deletes this job from the queue. Its children are kept, so a job with pending children is refused —
                remove the children first.
              </>
            ),
            needsPassword: false,
            password: '',
            setPassword: () => {},
            error: '',
            busy: removeBusy,
            confirmLabel: 'Remove job',
            confirm: () => {
              if (removeBusy) return;
              setConfirmRemove(false);
              removeJob({ queue, jobId }, () => setSearch({ jobId: undefined }));
            },
            cancel: () => setConfirmRemove(false),
          }}
        />
      )}
      <JobDetailView
        job={body}
        busy={retryBusy || removeBusy}
        onRetry={onRetry}
        onRemove={() => setConfirmRemove(true)}
      />
    </>
  );
}

export function JobDetailView({
  job,
  onRetry,
  onRemove,
  busy,
}: {
  job: QueueJobDetail;
  onRetry?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const queued = durationLabel(job.timestamp, job.processedOn);
  const ran = durationLabel(job.processedOn, job.finishedOn);
  const canRetry = job.state === 'failed' || job.state === 'completed';
  const canRemove = job.state !== 'active' && job.state !== 'unknown';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`font-mono text-xs ${stateTone(job.state)}`}>{job.state}</span>
        <span className="text-text-primary font-mono text-sm break-all">{job.id}</span>
        <CopyButton value={job.id} title="copy job id" />
        <span className="text-text-muted font-mono text-xs">{job.name}</span>
        {job.sealed && <span className="text-status-info/80 font-mono text-[11px]">sealed</span>}
        {(onRetry ?? onRemove) && (canRetry || canRemove) && (
          <span className="ml-auto flex gap-1.5">
            {onRetry && canRetry && <SvcBtn label="retry" disabled={busy} onClick={onRetry} />}
            {onRemove && canRemove && <SvcBtn label="remove" danger disabled={busy} onClick={onRemove} />}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Created" value={epochLabel(job.timestamp)} sub={queued ? `queued ${queued}` : undefined} />
        <Tile label="Started" value={epochLabel(job.processedOn)} sub={ran ? `ran ${ran}` : undefined} />
        <Tile
          label="Finished"
          value={epochLabel(job.finishedOn)}
          sub={job.delay > 0 ? `delay ${job.delay}ms` : undefined}
        />
        <Tile
          label="Attempts"
          value={job.attemptsMade}
          sub={job.attemptsMade > 0 ? 'consumed by real failures only' : 'none consumed'}
        />
      </div>

      <div className="border-border-dim bg-bg-secondary rounded-lg border p-3">
        <dl className="grid grid-cols-1 gap-1.5 font-mono text-[11px] sm:grid-cols-2">
          <Field label="device" value={job.deviceId} copy />
          <Field label="saga" value={job.sagaName} />
          <Field
            label="plan"
            value={job.planId}
            copy
            link={(planId) => (
              <Link
                to="/hub"
                search={(prev) => jobLifecycleSearch(prev, planId)}
                title="Open the lifecycle job this plan id belongs to — the same id the engine stores"
                className="border-accent/30 text-accent hover:bg-accent/10 shrink-0 rounded border px-1 text-[10px]"
              >
                lifecycle
              </Link>
            )}
          />
          <Field label="zone" value={job.zoneId} copy />
        </dl>
      </div>

      {job.failedReason && (
        <div className="space-y-1">
          <SubHeading>Failure</SubHeading>
          <ErrorBanner>{job.failedReason}</ErrorBanner>
        </div>
      )}

      {job.stacktrace.length > 0 && (
        <div className="space-y-1">
          <SubHeading>
            Stacktrace
            <span className="text-text-dim ml-2 font-mono text-[10px]">
              {job.stacktrace.length} frames, oldest first
            </span>
          </SubHeading>
          <div className="border-border-dim bg-bg-secondary relative rounded-lg border p-3">
            <div className="absolute top-2 right-2">
              <CopyButton value={job.stacktrace.join('\n\n')} title="copy stacktrace" />
            </div>
            <pre className="text-text-muted max-h-[40vh] overflow-auto pr-8 font-mono text-[11px] whitespace-pre-wrap">
              {job.stacktrace.join('\n\n')}
            </pre>
          </div>
        </div>
      )}

      {job.payload != null && (
        <div className="space-y-1">
          <SubHeading>
            Payload
            {job.payloadTruncated && (
              <span className="text-text-dim ml-2 font-mono text-[10px]">
                truncated — a prefix, not the whole job data
              </span>
            )}
          </SubHeading>
          <div className="border-border-dim bg-bg-secondary rounded-lg border p-3 font-mono text-[11px]">
            <Cell value={job.payload} />
          </div>
        </div>
      )}

      {job.aad && (
        <div className="space-y-1">
          <SubHeading>
            AAD header
            <span className="text-text-dim ml-2 font-mono text-[10px]">
              the only readable part of a sealed envelope
            </span>
          </SubHeading>
          <div className="border-border-dim bg-bg-secondary rounded-lg border p-3 font-mono text-[11px]">
            <Cell value={job.aad} />
          </div>
        </div>
      )}
    </div>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <div className="text-text-dim text-[10px] tracking-wide uppercase">{children}</div>;
}

function Field({
  label,
  value,
  copy,
  link,
}: {
  label: string;
  value: string | null;
  copy?: boolean;
  link?: (value: string) => ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-text-dim w-14 shrink-0">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        {value === null ? (
          <span className="text-text-label italic">null</span>
        ) : (
          <>
            <span className="text-text-primary truncate" title={value}>
              {value}
            </span>
            {copy && <CopyButton value={value} title={`copy ${label}`} />}
            {link?.(value)}
          </>
        )}
      </dd>
    </div>
  );
}
