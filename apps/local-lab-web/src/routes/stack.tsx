import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import {
  AnsiLogPane,
  DatastoreCard,
  GateModal,
  healthUi,
  OpList,
  RecentRuns,
  SectionHeading,
  SvcBtn,
} from '@/components/console';
import { FLEET_HEALTH_UI } from '@/components/fleet-status';
import { PendingBanner } from '@/components/pending-banner';
import { ProcessEnvPane } from '@/components/process-env';
import { InitDagStrip } from '@/components/status/init-dag';
import { StackStatusCard } from '@/components/status/stack-status-card';
import { SummaryRow } from '@/components/status/summary-row';
import { initFocusTask, streamPaths, type Service, type StackOp } from '@/contract';
import { ErrorBanner, errText } from '@/features/datastore/shared/error-banner';
import { ZoneRuntimeTiles } from '@/features/runtime';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtBytes } from '@/lib/format';
import { reportControl } from '@/lib/report-control';
import { validateStackSearch } from '@/lib/stack-search';
import { useToast } from '@/lib/toast';
import { useApplyConfirm } from '@/lib/use-apply-confirm';
import { useLogStream } from '@/lib/use-log-stream';
import { OPS_POLL_MS, useOps } from '@/lib/use-ops';

type LogSource =
  | { kind: 'op'; opId: string }
  | { kind: 'service'; id: string }
  | { kind: 'datastore'; id: string }
  | { kind: 'init'; name: string }
  | null;

// Service cards group by process-compose namespace (Service.group); these only set preferred order +
// display names. An unknown namespace auto-appears as its own section, sorted last, title-cased.
const GROUP_ORDER = ['hub', 'spoke', 'observability', 'control'];
const GROUP_LABELS: Record<string, string> = {
  hub: 'Hub',
  spoke: 'Spoke',
  observability: 'Observability',
  control: 'Control center',
};
const groupRank = (g: string): number => {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;
};
const titleCase = (s: string): string =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
const groupLabel = (g: string): string => GROUP_LABELS[g] ?? titleCase(g);

export function StackPage() {
  const stream = useLogStream();
  const toast = useToast();
  const { confirmApply } = useApplyConfirm();
  const [source, setSource] = useState<LogSource>(null);
  const [pane, setPane] = useState<'logs' | 'env'>('logs');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const state = tsr.getStackState.useQuery({ queryKey: ['stack-state'], refetchInterval: 3000 });
  const services = tsr.listServices.useQuery({ queryKey: ['services'], refetchInterval: 3000 });
  const init = tsr.getInitTasks.useQuery({ queryKey: ['stack-init'], refetchInterval: 3000 });
  const control = tsr.controlService.useMutation();
  const controlDs = tsr.controlDatastore.useMutation();
  // ids with an in-flight start/restart — fed to the status card so it reads coming-up at once
  // (the control call only returns once the process has settled, several seconds later).
  const [pending, setPending] = useState<Set<string>>(new Set());
  const markPending = (id: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const ops = useOps(
    'stack',
    (opId, runId) => {
      setSource({ kind: 'op', opId });
      setSelectedRun(runId);
      stream.open(streamPaths.run(runId));
    },
    (msg) => toast.error(msg),
  );
  // A running lifecycle op owns the control plane: lock the mutating op buttons and the per-process
  // controls until it finishes (or is Stopped), so nothing competes with it over process-compose.
  const domainBusy = !!ops.activeRun;

  // Re-open a finished run's console: the stream endpoint replays the buffered
  // backlog, so clicking a recent run restores the output it produced.
  const viewRun = (runId: string) => {
    const r = ops.runList.find((x) => x.runId === runId);
    setSource(r ? { kind: 'op', opId: r.opId } : null);
    setSelectedRun(runId);
    stream.open(streamPaths.run(runId));
  };

  const datastores = state.data?.status === 200 ? state.data.body.datastores : [];
  const fleet = state.data?.status === 200 ? state.data.body.fleet : undefined;
  const serviceList = services.data?.status === 200 ? services.data.body : [];
  const hubRunning = serviceList.some((s) => s.group === 'hub' && s.running);

  // Disabled services/datastores are pulled out of their normal groups into the collapsed Disabled
  // accordion so they don't clutter the list — still viewable and start-able on demand.
  const enabledDatastores = datastores.filter((d) => d.status !== 'disabled');
  const disabledDatastores = datastores.filter((d) => d.status === 'disabled');
  const disabledServices = serviceList
    .filter((s) => s.health === 'disabled')
    .slice()
    .sort((a, b) => a.port - b.port);
  const disabledCount = disabledServices.length + disabledDatastores.length;

  // already in the dag's declared order from the server; an unmapped task renders under its raw name.
  const initTasks = init.data?.status === 200 ? init.data.body : [];
  // An empty registry and a dead ops query both render as no buttons; only say so when it is the query.
  const opsFailure = ops.allOps.length === 0 ? errText(ops.opsData, ops.opsError) : null;
  const initAlert = initFocusTask(initTasks) !== undefined;
  const [initOpen, setInitOpen] = useState(false);
  // opens itself when a task starts running or fails, and stays wherever the operator leaves it after.
  useEffect(() => {
    if (initAlert) setInitOpen(true);
  }, [initAlert]);

  // no {done:true} sentinel on this tail, so it is declared infinite like the service logs.
  const viewInit = (name: string) => {
    setSource({ kind: 'init', name });
    setSelectedRun(null);
    setPane('logs');
    stream.open(streamPaths.stackInitLog(name), { finite: false });
  };

  const { init: initParam } = Route.useSearch();
  const deepLinked = useRef<string | null>(null);
  // no dependency array: stream.open is not memoised by useLogStream, so naming viewInit would trip
  // exhaustive-deps, and an empty array would miss a second deep link while the page stays mounted.
  useEffect(() => {
    if (!initParam || deepLinked.current === initParam) return;
    deepLinked.current = initParam;
    viewInit(initParam);
  });

  const viewService = (id: string) => {
    setSource({ kind: 'service', id });
    setSelectedRun(null);
    setPane('logs');
    stream.open(`/api/services/${id}/log`, { finite: false });
  };

  // Select a process and open its log stream too, so the Logs tab is just a view toggle — otherwise
  // switching to Logs would show a stale stream (the tab change alone never re-opens it).
  const viewServiceEnv = (id: string) => {
    setSource({ kind: 'service', id });
    setSelectedRun(null);
    setPane('env');
    stream.open(`/api/services/${id}/log`, { finite: false });
  };
  const viewDatastoreEnv = (id: string) => {
    setSource({ kind: 'datastore', id });
    setSelectedRun(null);
    setPane('env');
    stream.open(`/api/stack/datastores/${id}/log`, { finite: false });
  };

  const controlSvc = (id: string, action: 'start' | 'stop' | 'restart') => {
    if (action !== 'stop') markPending(id, true);
    control.mutate(
      { body: { id, action } },
      {
        onSuccess: (data) => {
          reportControl(toast, id, action, data);
          void services.refetch();
          if (action !== 'stop') viewService(id);
        },
        onError: (e) => toast.error(`${id}: ${action} — ${errorMessage(e) ?? 'request failed'}`),
        onSettled: () => markPending(id, false),
      },
    );
  };

  const viewDatastore = (id: string) => {
    setSource({ kind: 'datastore', id });
    setSelectedRun(null);
    setPane('logs');
    stream.open(`/api/stack/datastores/${id}/log`, { finite: false });
  };

  const controlDatastore = (id: string, action: 'start' | 'stop' | 'restart') => {
    if (action !== 'stop') markPending(id, true);
    controlDs.mutate(
      { body: { id, action } },
      {
        onSuccess: (data) => {
          reportControl(toast, id, action, data);
          setTimeout(() => void state.refetch(), 1000);
          if (action !== 'stop') viewDatastore(id);
        },
        onError: (e) => toast.error(`${id}: ${action} — ${errorMessage(e) ?? 'request failed'}`),
        onSettled: () => markPending(id, false),
      },
    );
  };

  // "Stack up" supervises hub itself — gate it while the hub is already running.
  const allDatastoresUp = state.data?.status === 200 ? state.data.body.datastoresUp : false;
  const gatedText = (op: StackOp) =>
    op.id === 'up' && hubRunning
      ? 'already up — use Stack restart'
      : op.id === 'datastores' && allDatastoresUp
        ? 'already up'
        : null;

  // fleet-apply can wipe a node disk (apply auto-passes --allow-data-loss); gate every launch
  // through the same confirm the banner/Settings use — the op-list button must not bypass it.
  const launchOp = async (op: StackOp) => {
    if (op.id === 'fleet-apply') {
      const { proceed, allowDataLoss } = await confirmApply();
      if (!proceed) return;
      ops.onOpClick(op, allowDataLoss);
      return;
    }
    ops.onOpClick(op);
  };
  const byGroup = (g: StackOp['group']) => ops.opList.filter((o) => o.group === g);
  const opListProps = { activeOp: ops.activeOp, disabled: ops.isPending, gatedText, onOpClick: launchOp };
  // Mutating sections (bring-up / destructive) are hard-locked while a lifecycle op runs; the
  // read-only Status section stays live.
  const mutatingOpProps = {
    ...opListProps,
    forceDisabled: domainBusy,
    disabledReason: ops.activeRun ? `${ops.activeRun.opId} running` : undefined,
  };

  const renderServiceCard = (svc: Service, allowEnable?: boolean) => (
    <ServiceCard
      key={svc.id}
      svc={svc}
      active={source?.kind === 'service' && source.id === svc.id}
      busy={control.isPending || domainBusy}
      onView={() => viewService(svc.id)}
      onViewEnv={() => viewServiceEnv(svc.id)}
      onControl={(action) => controlSvc(svc.id, action)}
      allowEnable={allowEnable}
    />
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:h-[calc(100dvh-7rem)] lg:grid-cols-[320px_1fr]">
      <div className="space-y-4 pr-1 lg:min-h-0 lg:overflow-auto">
        <SectionHeading>Stack</SectionHeading>
        <p className="text-text-dim text-[11px]">
          The control plane — datastores → hub → spoke. Reconcile self-heals; restart cycles it. The fleet is managed
          separately.
        </p>
        {opsFailure && (
          <ErrorBanner>
            op list unavailable — {opsFailure}. every section below is empty for that reason, not because there is
            nothing to run; retrying every {OPS_POLL_MS / 1000}s.
          </ErrorBanner>
        )}

        <div data-tour="stack-status" className="space-y-4">
          <SectionHeading>Status</SectionHeading>
          {state.data?.status === 200 && state.data.body.fleetPending && (
            <PendingBanner
              pending={state.data.body.fleetPending}
              busy={ops.runningOpIds.has('fleet-apply')}
              onApply={() => {
                // fleet-apply is a 'fleet'-section op, so it's absent from this page's section-filtered
                // opList — resolve it from the unfiltered list so the banner's Apply actually launches.
                const it = ops.allOps.find((o) => o.id === 'fleet-apply');
                if (it) void launchOp(it);
              }}
            />
          )}
          <StackStatusCard
            datastores={datastores}
            services={serviceList}
            activeRun={ops.activeRun}
            busy={ops.isPending}
            pending={pending}
            initTasks={initTasks}
            onReconcile={() => {
              const op = ops.opList.find((o) => o.id === 'reconcile');
              if (op) ops.onOpClick(op);
            }}
            onCancel={ops.cancelRun}
            onViewRun={viewRun}
          />
          {initTasks.length > 0 && (
            <InitDagStrip
              tasks={initTasks}
              activeName={source?.kind === 'init' ? source.name : undefined}
              open={initOpen}
              onToggle={() => setInitOpen((v) => !v)}
              onView={viewInit}
            />
          )}
          {fleet && (
            <SummaryRow ui={FLEET_HEALTH_UI[fleet.health]} label="Fleet" detail={fleet.detail} title={fleet.detail} />
          )}
          <ZoneRuntimeTiles />
          <OpList ops={byGroup('status')} {...opListProps} />
        </div>

        <div className="space-y-2">
          {[...new Set(serviceList.map((s) => s.group))]
            .sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b))
            .map((group) => {
              // Disabled services live in the collapsed Disabled accordion below, not their own group.
              const groupSvcs = serviceList
                .filter((s) => s.group === group && s.health !== 'disabled')
                .slice()
                .sort((a, b) => a.port - b.port);
              if (groupSvcs.length === 0) return null;
              // Spokes: sub-group the bridges by zone (multi-zone fleets). Hub and a single-zone /
              // legacy spoke (zone === null) render flat with no zone headers.
              const zones =
                group === 'spoke' ? [...new Set(groupSvcs.map((s) => s.zone).filter((z): z is string => !!z))] : [];
              return (
                <details key={group} open className="space-y-2">
                  <summary className="text-text-dim hover:text-text-muted cursor-pointer list-none text-[10px] tracking-wide uppercase">
                    {groupLabel(group)}
                  </summary>
                  <div className="space-y-2">
                    {zones.length > 0 ? (
                      <>
                        {zones.map((zone) => (
                          <div key={zone} className="space-y-2">
                            <div className="text-text-dim pl-0.5 font-mono text-[10px]">{zone}</div>
                            {groupSvcs.filter((s) => s.zone === zone).map((s) => renderServiceCard(s))}
                          </div>
                        ))}
                        {/* Zone-less members of a zoned group (e.g. a sibling process with no zone of
                            its own) still render — never silently dropped by the zone filter above. */}
                        {groupSvcs.filter((s) => !s.zone).map((s) => renderServiceCard(s))}
                      </>
                    ) : (
                      groupSvcs.map((s) => renderServiceCard(s))
                    )}
                  </div>
                </details>
              );
            })}
          {enabledDatastores.length > 0 && (
            <details open className="space-y-2">
              <summary className="text-text-dim hover:text-text-muted cursor-pointer list-none text-[10px] tracking-wide uppercase">
                Other
              </summary>
              <div className="space-y-2">
                {enabledDatastores.map((d) => (
                  <DatastoreCard
                    key={d.id}
                    ds={d}
                    active={source?.kind === 'datastore' && source.id === d.id}
                    busy={controlDs.isPending || domainBusy}
                    onView={() => viewDatastore(d.id)}
                    onViewEnv={() => viewDatastoreEnv(d.id)}
                    onControl={(action) => controlDatastore(d.id, action)}
                  />
                ))}
              </div>
            </details>
          )}
          {disabledCount > 0 && (
            <details className="space-y-2">
              <summary className="text-text-dim hover:text-text-muted cursor-pointer list-none text-[10px] tracking-wide uppercase">
                Disabled · {disabledCount}
              </summary>
              <div className="space-y-2">
                {disabledServices.map((s) => renderServiceCard(s, true))}
                {disabledDatastores.map((d) => (
                  <DatastoreCard
                    key={d.id}
                    ds={d}
                    active={source?.kind === 'datastore' && source.id === d.id}
                    busy={controlDs.isPending || domainBusy}
                    onView={() => viewDatastore(d.id)}
                    onViewEnv={() => viewDatastoreEnv(d.id)}
                    onControl={(action) => controlDatastore(d.id, action)}
                    allowEnable
                  />
                ))}
              </div>
            </details>
          )}
          {serviceList.length === 0 && datastores.length === 0 && (
            <div className="text-text-dim text-xs">no services</div>
          )}
        </div>

        <div data-tour="stack-bringup" className="space-y-4">
          <div className="pt-2">
            <SectionHeading>Bring up</SectionHeading>
          </div>
          <OpList ops={byGroup('bringup')} {...mutatingOpProps} />
        </div>

        <div data-tour="stack-destructive" className="space-y-4">
          <div className="pt-2">
            <SectionHeading>Destructive</SectionHeading>
          </div>
          <OpList ops={byGroup('destructive')} {...mutatingOpProps} />
        </div>

        <div data-tour="stack-recent" className="space-y-4">
          <div className="pt-2">
            <SectionHeading>Recent runs</SectionHeading>
          </div>
          <RecentRuns runs={ops.runList} onSelect={viewRun} onCancel={ops.cancelRun} activeId={selectedRun} />
        </div>
      </div>

      <div data-tour="stack-logs" className="relative flex min-h-0 flex-col">
        <div className="mb-2 flex items-center gap-2">
          {source?.kind === 'service' || source?.kind === 'datastore' ? (
            <div className="flex gap-1 text-xs">
              <PaneTab label="Logs" active={pane === 'logs'} onClick={() => setPane('logs')} />
              <PaneTab label="Environment" active={pane === 'env'} onClick={() => setPane('env')} />
            </div>
          ) : (
            <SectionHeading>Logs</SectionHeading>
          )}
          <div className="flex gap-1 text-xs">
            {serviceList.map((svc) => (
              <button
                key={svc.id}
                onClick={() => (pane === 'env' ? viewServiceEnv(svc.id) : viewService(svc.id))}
                className={[
                  'rounded-md border px-2 py-0.5 font-mono transition',
                  source?.kind === 'service' && source.id === svc.id
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-border-dim text-text-muted hover:bg-hover-bg',
                ].join(' ')}
              >
                {svc.id}
              </button>
            ))}
          </div>
          {source?.kind === 'op' && (
            <span className="text-accent font-mono text-xs lowercase">· op: {source.opId}</span>
          )}
          {source?.kind === 'datastore' && (
            <span className="text-accent font-mono text-xs lowercase">· datastore: {source.id}</span>
          )}
          {source?.kind === 'init' && (
            <span className="text-accent font-mono text-xs lowercase">· init: {source.name}</span>
          )}
        </div>
        {pane === 'env' && (source?.kind === 'service' || source?.kind === 'datastore') ? (
          <ProcessEnvPane name={source.id} />
        ) : (
          <AnsiLogPane
            logHtml={stream.logHtml}
            logRef={stream.logRef}
            placeholder="Run an operation, or pick a service tab to stream its logs."
            tail={{ on: stream.follow, toggle: () => stream.setFollow(!stream.follow) }}
            clear={stream.clear}
            degraded={stream.degraded}
            disconnected={stream.disconnected}
          />
        )}
        {ops.gate && <GateModal gate={ops.gate} />}
      </div>
    </div>
  );
}

/** Logs/Environment view-mode toggle for the detail pane. */
function PaneTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded-md border px-2 py-0.5 transition',
        active ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border-dim text-text-muted hover:bg-hover-bg',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

const trimZero = (s: string): string => s.replace(/\.0$/, '');
const fmtPct = (v: number): string => `${trimZero(v.toFixed(1))}%`;
const svcTelemetryLine = (svc: Service): string =>
  [
    svc.cpuPct !== undefined ? fmtPct(svc.cpuPct) : undefined,
    svc.memBytes !== undefined ? fmtBytes(svc.memBytes) : undefined,
    svc.age,
  ]
    .filter((seg): seg is string => seg !== undefined)
    .join(' · ');

function ServiceCard({
  svc,
  active,
  busy,
  onView,
  onViewEnv,
  onControl,
  allowEnable,
}: {
  svc: Service;
  active: boolean;
  busy: boolean;
  onView: () => void;
  onViewEnv: () => void;
  onControl: (action: 'start' | 'stop' | 'restart') => void;
  // lift the disabled guard so a disabled service can be started from the Disabled accordion.
  allowEnable?: boolean;
}) {
  const ui = healthUi(svc.health);
  const note = svc.restarts ? `${ui.note} · ↻${svc.restarts}` : ui.note;
  const telemetry = svcTelemetryLine(svc);
  return (
    <div
      className={[
        'rounded-md border px-3 py-2 text-sm',
        active ? 'border-accent/50 bg-accent/5' : 'border-border-dim',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <button onClick={onView} className="hover:text-text-primary flex items-center gap-2 text-left">
          <span className={`h-2 w-2 rounded-full ${ui.dot}`} />
          <span className="text-text-primary font-medium">{svc.label}</span>
          <span className="text-text-dim font-mono text-[11px]">:{svc.port}</span>
        </button>
        <span className={`text-[11px] ${ui.text}`}>{note}</span>
      </div>
      {telemetry && <div className="text-text-dim mt-1 font-mono text-[10px]">{telemetry}</div>}
      {svc.detail && svc.health !== 'up' && (
        <div className="text-text-dim mt-1 truncate text-[11px]" title={svc.detail}>
          {svc.detail}
        </div>
      )}
      <div className="mt-2 flex gap-1.5 text-[11px]">
        <SvcBtn
          label="start"
          disabled={busy || svc.running || (svc.health === 'disabled' && !allowEnable)}
          onClick={() => onControl('start')}
        />
        <SvcBtn label="restart" disabled={busy || !svc.running} onClick={() => onControl('restart')} />
        {svc.canStop && (
          <SvcBtn label="stop" danger disabled={busy || !svc.running} onClick={() => onControl('stop')} />
        )}
        <button onClick={onViewEnv} className="text-text-muted hover:bg-hover-bg ml-auto rounded px-2 py-1">
          env
        </button>
        <button onClick={onView} className="text-text-muted hover:bg-hover-bg rounded px-2 py-1">
          logs
        </button>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/stack')({ component: StackPage, validateSearch: validateStackSearch });
