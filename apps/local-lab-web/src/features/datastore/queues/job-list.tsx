import { useEffect, useState } from 'react';

import { QUEUE_JOB_STATES, type QueueJob, type QueueJobState } from '@/contract';
import { ErrorBanner } from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

import { INITIAL_PAGING, type JobPaging, type QueueAddress, advancePaging, mergeJobs, stateTone } from './queue-health';

const PAGE = 50;

interface PageFacts {
  deviceFilterSupported: boolean;
  discoveryCapped: boolean;
  cap: number;
}

export function JobList({
  queue,
  jobState,
  deviceId,
  selectedJobId,
  onSelectJob,
  onSelectState,
  onClearDevice,
}: {
  queue: QueueAddress;
  jobState: QueueJobState | undefined;
  deviceId: string | undefined;
  selectedJobId: string | undefined;
  onSelectJob: (jobId: string) => void;
  onSelectState: (state: QueueJobState | undefined) => void;
  onClearDevice: () => void;
}) {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [paging, setPaging] = useState<JobPaging>(INITIAL_PAGING);
  const [facts, setFacts] = useState<PageFacts | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (reset: boolean) => {
    setErr('');
    setBusy(true);
    const base = reset ? INITIAL_PAGING : paging;
    // a failed reset must drop the rows too, or the banner sits above the previous filter's jobs
    const fail = (message: string) => {
      setErr(message);
      if (!reset) return;
      setJobs([]);
      setPaging(INITIAL_PAGING);
      setFacts(null);
    };
    void tsr.listQueueJobs
      .query({
        params: { prefix: encodeURIComponent(queue.prefix), name: encodeURIComponent(queue.name) },
        query: { states: jobState, limit: PAGE, offset: base.offset, deviceId },
      })
      .then((res) => {
        if (res.status !== 200) {
          fail(errorMessage(res) ?? 'job listing failed');
          return;
        }
        setFacts({
          deviceFilterSupported: res.body.deviceFilterSupported,
          discoveryCapped: res.body.discoveryCapped,
          cap: res.body.cap,
        });
        setPaging(advancePaging(base, res.body, reset));
        setJobs((prev) => (reset ? res.body.jobs : mergeJobs(prev, res.body.jobs)));
      })
      .catch((thrown: unknown) => fail(errorMessage(thrown) ?? 'job listing failed'))
      .finally(() => setBusy(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(true), [queue.prefix, queue.name, jobState, deviceId]);

  const deviceUnfilterable = deviceId !== undefined && facts !== null && !facts.deviceFilterSupported;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        <StateChip label="all" active={jobState === undefined} onClick={() => onSelectState(undefined)} />
        {QUEUE_JOB_STATES.map((state) => (
          <StateChip
            key={state}
            label={state}
            tone={stateTone(state)}
            active={jobState === state}
            onClick={() => onSelectState(state)}
          />
        ))}
      </div>

      {deviceId && (
        <div className="border-border-dim text-text-muted flex items-center gap-2 rounded border border-dashed px-2 py-1 font-mono text-[11px]">
          <span className="text-text-dim">device</span>
          <span className="truncate" title={deviceId}>
            {deviceId}
          </span>
          <button onClick={onClearDevice} className="text-text-dim hover:text-accent ml-auto shrink-0">
            clear
          </button>
        </div>
      )}

      {err && <ErrorBanner>{err}</ErrorBanner>}

      {deviceUnfilterable && (
        <div className="border-status-warning/30 bg-status-warning/5 space-y-1 rounded-md border px-2 py-1.5 font-mono text-[11px]">
          <div className="text-status-warning/90 text-[10px] tracking-wide uppercase">
            device filter cannot be answered for this queue
          </div>
          <div className="text-text-muted">
            jobs here are enqueued without an explicit id, so BullMQ numbers them 1, 2, 3 and the device appears only in
            the payload — ciphertext for an enrolled zone. an empty result means cannot be determined from job ids, not
            that the device is absent from this queue.
          </div>
        </div>
      )}

      <JobTable jobs={jobs} selectedId={selectedJobId} onSelect={onSelectJob} />

      {jobs.length === 0 && !busy && !err && !deviceUnfilterable && (
        <div className="text-text-dim px-1 text-xs">
          {paging.more
            ? 'no matching jobs in this window — load more to continue scanning'
            : deviceId
              ? 'no jobs for this device in this queue'
              : 'no jobs in the states read'}
        </div>
      )}

      <div className="text-text-dim font-mono text-[10px]">
        {jobs.length} read{paging.more ? ' · each state is windowed separately; more exist beyond this window' : ''}
      </div>

      {facts?.discoveryCapped && (
        <div className="border-border-dim text-text-muted rounded-md border border-dashed px-2 py-1.5 font-mono text-[11px]">
          discovery stopped at the cap of {facts.cap} job ids, and the remainder is unreachable from here — the id scan
          restarts at the beginning of the keyspace on every request, so a further offset only re-reads these same ids.
        </div>
      )}

      {paging.more && (
        <button
          onClick={() => load(false)}
          disabled={busy}
          className="border-border-dim text-text-muted hover:bg-hover-bg w-full rounded-md border border-dashed px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {busy ? 'reading…' : `load more (offset ${paging.offset})`}
        </button>
      )}
    </div>
  );
}

function StateChip({
  label,
  tone,
  active,
  onClick,
}: {
  label: string;
  tone?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded border px-1.5 py-0.5 font-mono text-[10px] transition',
        active ? 'border-accent/50 bg-accent/10 text-accent' : `border-border-dim hover:bg-hover-bg ${tone ?? ''}`,
      ].join(' ')}
    >
      {label}
    </button>
  );
}

export function JobTable({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: readonly QueueJob[];
  selectedId: string | undefined;
  onSelect: (jobId: string) => void;
}) {
  if (jobs.length === 0) return null;

  return (
    <div className="max-h-[55vh] space-y-0.5 overflow-auto pr-1">
      {jobs.map((job) => (
        <button
          key={job.id}
          onClick={() => onSelect(job.id)}
          className={[
            'block w-full rounded px-2 py-1 text-left font-mono text-[11px]',
            selectedId === job.id ? 'bg-accent/15' : 'hover:bg-hover-bg',
          ].join(' ')}
        >
          <div className="flex items-center gap-2">
            <span className={`shrink-0 ${stateTone(job.state)}`}>{job.state}</span>
            <span className="text-text-primary truncate">{job.sagaName ?? job.name}</span>
            {job.sealed && (
              <span className="text-status-info/70 ml-auto shrink-0 text-[10px]" title="sealed zone envelope">
                sealed
              </span>
            )}
          </div>
          <div className="text-text-dim flex items-center gap-2 text-[10px]">
            <span className="truncate" title={job.id}>
              {job.id}
            </span>
            <span className={`ml-auto shrink-0 ${job.attemptsMade > 0 ? 'text-status-warning/80' : ''}`}>
              {job.attemptsMade} att
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
