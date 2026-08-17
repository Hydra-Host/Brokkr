import { Tile } from '@/components/ui/tile';
import { Unknown } from '@/components/ui/unknown';
import type { LifecycleJobRow, LifecyclePhaseCount } from '@/contract';
import { LIFECYCLE_JOB_PHASES } from '@/contract';
import { CopyButton } from '@/features/datastore/shared/copy-button';
import { fmtAgo, fmtDeadline } from '@/lib/format';
import type { HubSearch } from '@/lib/hub-search';

import { ListState } from './hub-shell';
import { PHASE_GROUPS, PHASE_TONE } from './hub-status';
import { QueueJobsPanel } from './queue-jobs-panel';
import { SagaTimeline } from './saga-timeline';
import { useLifecycleJob, useLifecycleJobs } from './use-hub';

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((entry) => b.includes(entry));

/** Counted over the whole table, not the page, so these are totals — and an unread census says so
 *  rather than rendering zeros that would read as an empty fleet. */
function PhaseCensus({
  counts,
  readError,
}: {
  counts: LifecyclePhaseCount[] | undefined;
  readError: string | null | undefined;
}) {
  if (readError) {
    return <div className="text-status-warning text-[11px]">phase census unavailable — {readError}</div>;
  }
  if (!counts) return null;

  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const inGroup = (label: string) => {
    const group = PHASE_GROUPS.find((entry) => entry.label === label);
    return counts.filter((entry) => group?.phases.includes(entry.phase)).reduce((sum, entry) => sum + entry.count, 0);
  };
  const ofPhase = (phase: string) => counts.find((entry) => entry.phase === phase)?.count ?? 0;

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Tile label="In flight" value={inGroup('in flight')} sub="not yet terminal" />
      <Tile label="Awaiting phone-home" value={ofPhase('AWAITING_PHONE_HOME')} sub="waiting on the device callback" />
      <Tile label="Failed" value={ofPhase('FAILED')} sub={`${ofPhase('ABORTED')} aborted`} />
      <Tile label="Total" value={total} sub="every job the device filter admits" />
    </div>
  );
}

function PhaseFilter({ search, setSearch }: { search: HubSearch; setSearch: (patch: Partial<HubSearch>) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-text-dim text-[10px] tracking-wide uppercase">phase</span>
      <button
        onClick={() => setSearch({ phases: [] })}
        className={`border-border-dim rounded border px-2 py-0.5 ${search.phases.length === 0 ? 'text-text-primary border-accent' : 'text-text-dim'}`}
      >
        all
      </button>
      {PHASE_GROUPS.map((group) => (
        <button
          key={group.label}
          onClick={() => setSearch({ phases: [...group.phases] })}
          className={`border-border-dim rounded border px-2 py-0.5 ${sameSet(search.phases, group.phases) ? 'text-text-primary border-accent' : 'text-text-dim'}`}
        >
          {group.label}
        </button>
      ))}
      <select
        aria-label="phase"
        value={search.phases.length === 1 ? search.phases[0] : ''}
        onChange={(e) => {
          const phase = LIFECYCLE_JOB_PHASES.find((entry) => entry === e.target.value);
          setSearch({ phases: phase ? [phase] : [] });
        }}
        className="border-border-dim bg-bg-secondary text-text-muted rounded border px-2 py-0.5 font-mono text-[11px]"
      >
        <option value="">any phase</option>
        {PHASE_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.phases.map((phase) => (
              <option key={phase} value={phase}>
                {phase.toLowerCase()}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {search.deviceId && (
        <button
          onClick={() => setSearch({ deviceId: undefined })}
          className="border-accent/30 text-accent ml-auto rounded border px-2 py-0.5"
          title="clear the device filter this page was opened with"
        >
          device {search.deviceId.slice(-6)} ✕
        </button>
      )}
    </div>
  );
}

/** Widened past the contract on purpose: the lab api is a built artifact while this is a hot dev
 *  server, so a field it predates arrives absent — unknown, not a measured absence of steps. */
function StepLine({ step }: { step: LifecycleJobRow['latestStep'] | undefined }) {
  if (step === undefined) {
    return <Unknown title="this build of the lab api does not report the newest step — rebuild and restart it" />;
  }
  if (step === null) return <span title="this job has recorded no timeline events yet">no steps yet</span>;
  return (
    <span className={step.error === null ? '' : 'text-status-offline'}>
      {step.sagaName}/{step.stepName}
      {step.attempt > 0 && ` ×${step.attempt + 1}`}
    </span>
  );
}

/** Two lines per job rather than a table: the list column is 22rem, and four truncated table cells
 *  there read as four ellipses. Mirrors the queue inspector's job list. */
function JobRow({
  job,
  selected,
  nowMs,
  onSelect,
}: {
  job: LifecycleJobRow;
  selected: boolean;
  nowMs: number;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`block w-full rounded px-2 py-1 text-left font-mono text-[11px] ${selected ? 'bg-accent/15' : 'hover:bg-hover-bg'}`}
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 ${PHASE_TONE[job.phase]}`}>{job.phase.toLowerCase()}</span>
        <span className="text-text-primary truncate">{job.jobType}</span>
      </div>
      <div className="text-text-dim flex items-center gap-2 text-[10px]">
        <span className="truncate" title={job.deviceId ?? undefined}>
          {job.deviceId ?? <span title="this job is not scoped to a device">—</span>}
        </span>
        <span className="ml-auto shrink-0">{fmtAgo(job.updatedAtMs, nowMs)}</span>
      </div>
      <div className="text-text-dim truncate text-[10px]">
        <StepLine step={job.latestStep} />
      </div>
    </button>
  );
}

function JobDetail({ jobId, nowMs }: { jobId: string; nowMs: number }) {
  const { detail, error, isPending } = useLifecycleJob(jobId);

  if (error) return <div className="text-status-offline font-mono text-xs">{error}</div>;
  if (isPending || !detail) return <div className="text-text-dim text-xs">loading…</div>;
  if (detail.job === null) {
    return <div className="text-text-dim font-mono text-xs">no job carries id {jobId}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="border-border-dim bg-bg-secondary rounded-lg border p-3 font-mono text-[11px]">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={PHASE_TONE[detail.job.phase]}>{detail.job.phase}</span>
          <span className="text-text-primary">{detail.job.jobType}</span>
          <span className="text-text-dim">{detail.job.source}</span>
          {detail.job.phoneHomeDeadlineMs !== null && (
            <span className="text-text-dim ml-auto" title="missing this deadline fails the job">
              phone-home deadline {fmtDeadline(detail.job.phoneHomeDeadlineMs, nowMs)}
            </span>
          )}
        </div>
        <div className="text-text-dim mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[10px]">
          <span>device {detail.job.deviceId ?? <span title="this job is not scoped to a device">—</span>}</span>
          <span>plan {detail.job.id}</span>
          <span>updated {fmtAgo(detail.job.updatedAtMs, nowMs)}</span>
        </div>
        {detail.job.error && <div className="text-status-offline mt-1 break-words">{detail.job.error}</div>}
      </div>

      <div>
        <div className="text-text-dim mb-1 text-[10px] tracking-wide uppercase">saga queue jobs</div>
        <QueueJobsPanel job={detail.job} nowMs={nowMs} />
      </div>

      <div>
        <div
          className="text-text-dim mb-1 text-[10px] tracking-wide uppercase"
          title={
            detail.eventsTruncated ? 'this job has more events than the read cap; the oldest are missing' : undefined
          }
        >
          timeline{detail.eventsTruncated && ' (oldest omitted)'}
        </div>
        <ListState error={null} readError={detail.eventsReadError} skipped={detail.eventsSkipped} isPending={false}>
          {detail.events.length === 0 ? (
            <div className="text-text-dim font-mono text-[11px]">no events recorded</div>
          ) : (
            <SagaTimeline events={detail.events} nowMs={nowMs} />
          )}
        </ListState>
      </div>

      <details className="border-border-dim bg-bg-secondary rounded-lg border">
        <summary className="text-text-dim cursor-pointer px-3 py-2 text-[10px] tracking-wide uppercase">
          payload{detail.payloadTruncated && ' (truncated)'}
        </summary>
        <pre className="text-text-muted max-h-96 overflow-auto px-3 pb-3 font-mono text-[11px] break-words whitespace-pre-wrap">
          {JSON.stringify(detail.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function LifecycleTab({
  search,
  setSearch,
  nowMs = Date.now(),
}: {
  search: HubSearch;
  setSearch: (patch: Partial<HubSearch>) => void;
  nowMs?: number;
}) {
  const { page, error, isPending } = useLifecycleJobs(search.phases, search.deviceId);

  return (
    <div data-tour="hub-lifecycle" className="space-y-3">
      <PhaseFilter search={search} setSearch={setSearch} />
      <PhaseCensus counts={page?.counts} readError={page?.countsReadError} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <ListState error={error} readError={page?.readError} skipped={page?.skipped} isPending={isPending}>
          {page && page.rows.length === 0 ? (
            <div className="text-text-dim px-1 text-xs">no jobs match</div>
          ) : (
            // bounded so the list cannot push the detail below the fold, however many jobs it holds
            <div className="max-h-[55vh] space-y-0.5 overflow-auto pr-1">
              {page?.rows.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={search.jobId === job.id}
                  nowMs={nowMs}
                  onSelect={() => setSearch({ jobId: job.id })}
                />
              ))}
            </div>
          )}
        </ListState>

        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-text-dim text-[10px] tracking-wide uppercase">job</span>
            {search.jobId && <CopyButton value={search.jobId} />}
          </div>
          {search.jobId ? (
            <JobDetail jobId={search.jobId} nowMs={nowMs} />
          ) : (
            <div className="text-text-dim text-xs">select a job to see its saga timeline and payload</div>
          )}
        </div>
      </div>
    </div>
  );
}
