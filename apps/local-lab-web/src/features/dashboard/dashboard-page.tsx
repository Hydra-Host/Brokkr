import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Fragment, useEffect, useState } from 'react';

import { SectionHeading } from '@/components/console';
import { FleetBringupProgress } from '@/components/fleet-status';
import { FLEET_HEALTH_UI, healthUi } from '@/components/status/health-ui';
import { InitDagStrip } from '@/components/status/init-dag';
import { StatusDot } from '@/components/status/status-card';
import { SummaryRow } from '@/components/status/summary-row';
import { initFocusTask, type FleetStatus, type InitTask, type Run, type Status } from '@/contract';
import { ErrorBanner, errText } from '@/features/datastore/shared/error-banner';
import { tsr } from '@/lib/api';
import { fmtAgo } from '@/lib/format';

import {
  CONNECTOR_CLASS,
  deriveHero,
  fleetSummaryLine,
  footerParts,
  initSummaryLine,
  POWER_DOT,
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  runRoute,
  STAGE_DOT,
  type PipelineStage,
} from './dashboard-model';
import { StacksPanel } from './stacks-panel';

export const STATUS_POLL_MS = 5_000;
export const INIT_POLL_MS = 3_000;
export const INIT_IDLE_POLL_MS = 30_000;

function Panel({ title, linkTo, children }: { title: string; linkTo: '/fleet' | '/stack'; children: ReactNode }) {
  return (
    <section className="border-border-dim rounded-md border px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeading>{title}</SectionHeading>
        <Link to={linkTo} className="text-text-dim hover:text-text-muted text-[11px]">
          open →
        </Link>
      </div>
      {children}
    </section>
  );
}

function StageBlock({ stage }: { stage: PipelineStage }) {
  return (
    <div className="min-w-0 shrink-0">
      <div className="flex items-center gap-2">
        <StatusDot className={STAGE_DOT[stage.state]} />
        <span className="text-text-primary text-sm font-medium">{stage.label}</span>
      </div>
      {stage.sublines.map((line) => (
        <div
          key={line.text}
          className={`mt-0.5 truncate pl-4 text-[11px] ${line.failed ? 'text-status-offline/90' : 'text-text-dim'}`}
          title={line.text}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

function ControlPlaneHero({ status, initTasks }: { status: Status; initTasks: InitTask[] }) {
  const hero = deriveHero(status, initTasks);
  return (
    <section className="border-border-dim rounded-md border px-4 py-5" data-tour="overview-hero">
      <div className="flex items-start">
        {hero.stages.map((stage, i) => (
          <Fragment key={stage.key}>
            {i > 0 && <div className={`mx-3 mt-2 h-px min-w-8 flex-1 ${CONNECTOR_CLASS[stage.state]}`} />}
            <StageBlock stage={stage} />
          </Fragment>
        ))}
      </div>
      <div
        className={`mt-4 flex items-center gap-2 text-[11px] ${hero.line.failed ? 'text-status-offline' : 'text-text-dim'}`}
      >
        <StatusDot className={FLEET_HEALTH_UI[hero.stack.health].dot} />
        <span>{hero.line.text}</span>
        {hero.directive && (
          <Link to="/stack" search={{ init: undefined }} className="text-accent hover:underline">
            open Stack →
          </Link>
        )}
      </div>
    </section>
  );
}

const FLEET_HEALTH_DETAIL_REDUNDANT: ReadonlySet<FleetStatus['health']> = new Set(['ready', 'idle', 'disabled']);

function FleetHealthLine({ fleetHealth }: { fleetHealth: FleetStatus }) {
  const ui = FLEET_HEALTH_UI[fleetHealth.health];
  const failed = fleetHealth.health === 'failed';
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 text-[11px]">
        <StatusDot className={ui.dot} />
        <span className={ui.text}>{ui.note}</span>
        <span className="text-text-dim shrink-0">
          {fleetHealth.machinesRunning}/{fleetHealth.machinesExpected} VMs on
        </span>
      </div>
      {!FLEET_HEALTH_DETAIL_REDUNDANT.has(fleetHealth.health) && (
        <div
          className={`mt-0.5 truncate text-[11px] ${failed ? 'text-status-offline/90' : 'text-text-dim'}`}
          title={fleetHealth.detail}
        >
          {fleetHealth.detail}
        </div>
      )}
      {fleetHealth.health === 'coming-up' && <FleetBringupProgress fleet={fleetHealth} />}
    </div>
  );
}

function FleetPanel({ status }: { status: Status }) {
  const fleetHealth = status.fleetHealth;
  return (
    <Panel title="Fleet" linkTo="/fleet">
      {fleetHealth && fleetHealth.machinesExpected > 0 && <FleetHealthLine fleetHealth={fleetHealth} />}
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {status.fleet.map((node) => (
          <span
            key={node.name}
            className="flex items-center gap-1.5 text-[11px]"
            title={`${node.name} — ${node.power}${node.lifecycleStatus ? ` · ${node.lifecycleStatus}` : ''}`}
          >
            <StatusDot className={POWER_DOT[node.power]} />
            <span className="text-text-muted">{node.name}</span>
          </span>
        ))}
        {status.fleet.length === 0 && <span className="text-text-dim text-[11px]">no fleet nodes</span>}
      </div>
      {status.fleetSummary && status.fleet.length > 0 && (
        <div className="text-text-dim mt-2 text-[11px]">{fleetSummaryLine(status.fleetSummary)}</div>
      )}
      {status.lastTestRun && (
        <Link to="/results" className="hover:text-text-primary mt-2 flex items-center gap-2 text-[11px]">
          <StatusDot className={RUN_STATUS_DOT[status.lastTestRun.status]} />
          <span className="text-text-muted truncate">last test: {status.lastTestRun.label}</span>
          <span className={RUN_STATUS_TEXT[status.lastTestRun.status]}>{status.lastTestRun.status}</span>
          <span className="text-text-dim shrink-0">{fmtAgo(status.lastTestRun.startedAt)}</span>
        </Link>
      )}
    </Panel>
  );
}

function runLabel(run: Run): string {
  return run.status === 'failed' && run.exitCode !== null ? `${run.status} (${run.exitCode})` : run.status;
}

function RecentPanel({ runs }: { runs: Run[] | undefined }) {
  return (
    <Panel title="Recent activity" linkTo="/stack">
      {runs === undefined && <div className="text-status-offline/90 text-[11px]">run ledger unreadable</div>}
      {runs?.length === 0 && <div className="text-text-dim text-[11px]">no runs recorded yet</div>}
      <div>
        {(runs ?? []).map((run) => (
          <Link
            key={run.runId}
            to={runRoute(run)}
            className="hover:bg-hover-bg -mx-1 flex items-center gap-2 rounded px-1 py-1.5 text-[11px]"
          >
            <span className="text-text-muted min-w-0 flex-1 truncate" title={run.opId}>
              {run.label}
            </span>
            <span className={`shrink-0 ${RUN_STATUS_TEXT[run.status]}`}>{runLabel(run)}</span>
            <span className="text-text-dim w-10 shrink-0 text-right">{fmtAgo(run.startedAt)}</span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const status = tsr.getStatus.useQuery({ queryKey: ['status'], refetchInterval: STATUS_POLL_MS });
  const body = status.data?.status === 200 ? status.data.body : undefined;
  const failure = errText(status.data, status.error);
  const initStatus = body?.initStatus;
  const initBusy = initStatus?.state === 'running' || initStatus?.state === 'failed';
  const init = tsr.getInitTasks.useQuery({
    queryKey: ['stack-init'],
    enabled: (initStatus?.total ?? 0) > 0,
    refetchInterval: initBusy ? INIT_POLL_MS : INIT_IDLE_POLL_MS,
  });
  const stacks = tsr.listStacks.useQuery({ queryKey: ['stacks'], refetchInterval: STATUS_POLL_MS });
  const initTasks = init.data?.status === 200 ? init.data.body : [];
  const [initOpen, setInitOpen] = useState(false);
  const initAlert = initFocusTask(initTasks) !== undefined;
  // opens itself when a task starts running or fails, and stays wherever the operator leaves it after
  useEffect(() => {
    if (initAlert) setInitOpen(true);
  }, [initAlert]);
  const stacksBody = stacks.data?.status === 200 ? stacks.data.body : undefined;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <SectionHeading>Overview</SectionHeading>
        <p className="text-text-dim text-[11px]">
          The whole environment at a glance — everything here links into the page that owns it.
        </p>
      </div>
      {failure && <ErrorBanner>{failure}</ErrorBanner>}
      {body === undefined ? (
        !failure && <div className="text-text-dim text-xs">waiting for the control-center API…</div>
      ) : (
        <>
          <ControlPlaneHero status={body} initTasks={initTasks} />
          {initTasks.length > 0 && (
            <InitDagStrip
              tasks={initTasks}
              open={initOpen}
              onToggle={() => setInitOpen((v) => !v)}
              onView={(name) => void navigate({ to: '/stack', search: { init: name } })}
            />
          )}
          {initTasks.length === 0 && initStatus !== undefined && initStatus.total > 0 && !init.isPending && (
            <SummaryRow
              ui={healthUi(initStatus.state)}
              label="Init DAG"
              detail={initSummaryLine(initStatus)}
              title="the init roster could not be read; this is the aggregate the status endpoint reported"
            />
          )}
          <StacksPanel stacks={stacksBody?.stacks ?? []} selfSlot={stacksBody?.selfSlot ?? null} />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <FleetPanel status={body} />
            <RecentPanel runs={body.recentRuns} />
          </div>
          <div className="text-text-dim text-[11px]">{footerParts(body).join(' · ')}</div>
        </>
      )}
    </div>
  );
}
