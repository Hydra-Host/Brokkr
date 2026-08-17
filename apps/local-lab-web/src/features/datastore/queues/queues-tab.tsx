import { useState } from 'react';

import { GateModal, SectionHeading, SvcBtn } from '@/components/console';
import { QueueCleanableStateSchema, type QueueCleanableState, type QueueJobState, type QueueSummary } from '@/contract';
import {
  ErrorBanner,
  Tile,
  errText,
  useDatastoreSearch,
  useFilterParam,
  useSetDatastoreSearch,
} from '@/features/datastore/shared';
import { tsr } from '@/lib/api';

import { JobDetailPanel } from './job-detail';
import { JobList } from './job-list';
import { summarizeQueues, type QueueTotals } from './queue-health';
import { QueueTable } from './queue-table';
import { useQueueMutations } from './use-queue-mutations';

const REFRESH_MS = 2000;
const CLEAN_LIMIT = 1_000;
const CLEANABLE_STATES = QueueCleanableStateSchema.options;

function pausedSub(totals: QueueTotals): string {
  const parts: string[] = [];
  if (totals.pausedQueues > 0) parts.push(`${totals.pausedQueues} paused`);
  if (totals.pausedUnknown > 0) parts.push(`${totals.pausedUnknown} pause unknown`);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

export function QueuesTab() {
  const queues = tsr.listQueues.useQuery({ queryKey: ['queues'], refetchInterval: REFRESH_MS });
  const { queuePrefix, queueName, jobState, jobId, deviceId } = useDatastoreSearch();
  const setSearch = useSetDatastoreSearch();
  const { filter, setFilter } = useFilterParam('queueFilter');
  // the job list is a raw-query component with no refetch handle, so a mutation refreshes it by remount
  const [jobNonce, setJobNonce] = useState(0);
  const [drainOpen, setDrainOpen] = useState(false);
  const [drainDelayed, setDrainDelayed] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleanState, setCleanState] = useState<QueueCleanableState>('failed');
  const [cleanGrace, setCleanGrace] = useState('0');

  const jobsChanged = () => {
    void queues.refetch();
    setJobNonce((n) => n + 1);
  };
  const { drainQueue, cleanQueue, drainBusy, cleanBusy } = useQueueMutations(jobsChanged);

  const err = errText(queues.data, queues.error);
  const list = !err && queues.data?.status === 200 ? queues.data.body : [];
  const totals = summarizeQueues(list);
  const needle = filter.toLowerCase();
  const filtered = list.filter((queue) => `${queue.prefix}/${queue.name}`.toLowerCase().includes(needle));

  const selected =
    queuePrefix !== undefined && queueName !== undefined ? { prefix: queuePrefix, name: queueName } : null;

  // gate options are per-attempt, and a queue switch retargets any open gate — both restore defaults
  const closeGates = () => {
    setDrainOpen(false);
    setDrainDelayed(false);
    setCleanOpen(false);
    setCleanState('failed');
    setCleanGrace('0');
  };

  const selectQueue = (queue: QueueSummary) => {
    closeGates();
    setSearch({ queuePrefix: queue.prefix, queueName: queue.name, jobId: undefined });
  };
  const selectState = (state: QueueJobState | undefined) => setSearch({ jobState: state, jobId: undefined });

  return (
    <div data-tour="datastore-queues" className="space-y-4">
      {err ? (
        <ErrorBanner>{err}</ErrorBanner>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Tile
            label="Queues"
            value={totals.queues}
            sub={
              totals.unreadable > 0 ? (
                <span className="text-status-offline">{totals.unreadable} unreadable</span>
              ) : (
                'all read cleanly'
              )
            }
          />
          <Tile
            label="In flight"
            value={totals.inFlight}
            sub={`${totals.workers} workers${totals.workersUnknown > 0 ? ` · ${totals.workersUnknown} unknown` : ''}`}
          />
          <Tile
            label="Failed"
            value={totals.failed}
            sub={`${totals.completed} retained complete${pausedSub(totals)}`}
          />
          <Tile
            label="Stalled"
            value={totals.stalled}
            sub={totals.unreadable > 0 ? 'totals exclude unreadable queues' : undefined}
          />
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SectionHeading>Queues</SectionHeading>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter queues…"
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 ml-auto w-56 rounded border px-2 py-1 font-mono text-xs outline-none"
          />
        </div>
        {!err && (
          <QueueTable
            queues={filtered}
            selected={selected}
            onSelect={selectQueue}
            placeholder={
              queues.isLoading
                ? 'loading…'
                : list.length > 0
                  ? `no queues match “${filter}”`
                  : 'no queues discovered — nothing has written a BullMQ meta key yet'
            }
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SectionHeading>Jobs</SectionHeading>
            <div className="ml-auto flex gap-1.5 text-[11px]">
              <SvcBtn
                label="drain"
                danger
                disabled={selected === null || drainBusy || cleanBusy}
                onClick={() => setDrainOpen(true)}
              />
              <SvcBtn
                label="clean"
                danger
                disabled={selected === null || drainBusy || cleanBusy}
                onClick={() => setCleanOpen(true)}
              />
            </div>
          </div>
          {selected ? (
            <JobList
              key={`${selected.prefix}/${selected.name}/${jobNonce}`}
              queue={selected}
              jobState={jobState}
              deviceId={deviceId}
              selectedJobId={jobId}
              onSelectJob={(id) => setSearch({ jobId: id })}
              onSelectState={selectState}
              onClearDevice={() => setSearch({ deviceId: undefined })}
            />
          ) : (
            <div className="text-text-dim px-1 text-xs">select a queue to list its jobs.</div>
          )}
        </div>

        <div className="min-w-0">
          {selected && jobId ? (
            <JobDetailPanel queue={selected} jobId={jobId} onChanged={jobsChanged} />
          ) : (
            <div className="text-text-dim text-sm">select a job to inspect its timing, attempts and failure.</div>
          )}
        </div>
      </div>

      {drainOpen && selected && (
        <GateModal
          fixed
          gate={{
            label: `Drain ${selected.prefix}/${selected.name}`,
            destructive: true,
            description: (
              <>
                Removes every wait, paused, and prioritized job. Active, completed, failed, and waiting-children jobs
                are never touched, and a repeatable scheduler's current delayed job is spared either way, so draining
                never breaks a schedule.
                <label className="text-text-primary mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={drainDelayed} onChange={(e) => setDrainDelayed(e.target.checked)} />
                  also remove delayed jobs
                </label>
              </>
            ),
            needsPassword: false,
            password: '',
            setPassword: () => {},
            error: '',
            busy: drainBusy,
            confirmLabel: 'Drain queue',
            confirm: () => {
              if (drainBusy) return;
              const queue = selected;
              closeGates();
              drainQueue(queue, drainDelayed, () => setSearch({ jobId: undefined }));
            },
            cancel: closeGates,
          }}
        />
      )}

      {cleanOpen && selected && (
        <GateModal
          fixed
          gate={{
            label: `Clean ${selected.prefix}/${selected.name}`,
            destructive: true,
            description: (
              <>
                Bulk-deletes retained jobs of one state, up to {CLEAN_LIMIT} per call.
                <label className="text-text-primary mt-2 flex items-center gap-2">
                  state
                  <select
                    value={cleanState}
                    onChange={(e) => {
                      const next = CLEANABLE_STATES.find((state) => state === e.target.value);
                      if (next) setCleanState(next);
                    }}
                    className="border-border-dim bg-bg-primary text-text-primary rounded border px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {CLEANABLE_STATES.map((state) => (
                      <option key={state} value={state}>
                        {state}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-text-primary mt-1 flex items-center gap-2">
                  grace (ms)
                  <input
                    type="number"
                    min={0}
                    value={cleanGrace}
                    onChange={(e) => setCleanGrace(e.target.value)}
                    className="border-border-dim bg-bg-primary text-text-primary w-28 rounded border px-1.5 py-0.5 font-mono text-[11px]"
                  />
                </label>
              </>
            ),
            needsPassword: false,
            password: '',
            setPassword: () => {},
            error: '',
            busy: cleanBusy,
            confirmLabel: 'Clean queue',
            confirm: () => {
              if (cleanBusy) return;
              const queue = selected;
              const grace = Number.parseInt(cleanGrace, 10);
              closeGates();
              cleanQueue(
                queue,
                {
                  state: cleanState,
                  grace: Number.isFinite(grace) && grace >= 0 ? grace : 0,
                  limit: CLEAN_LIMIT,
                },
                () => setSearch({ jobId: undefined }),
              );
            },
            cancel: closeGates,
          }}
        />
      )}
    </div>
  );
}
