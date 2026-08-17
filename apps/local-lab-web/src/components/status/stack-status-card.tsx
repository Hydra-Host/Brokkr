import type { FleetStatus, InitTask, Run, Service } from '@/contract';

import { FLEET_HEALTH_UI } from './health-ui';
import { StagedProgress, type Step, type StepState } from './staged-progress';
import { StatusCard } from './status-card';

type DatastoreLike = { id: string; status: string };
type StackHealth = FleetStatus['health'];

export type StackStatus = { health: StackHealth; pct: number; steps: Step[]; detail: string };

/** Which tier an init task gates, so the bar can't read ready while one is still running. `apps:init`
 *  and `fleet:init` are absent deliberately: neither the control center nor the fleet is a tier here. */
const INIT_TIER: Record<string, 'hub' | 'spoke'> = {
  'hub:init': 'hub',
  'hub:migrate': 'hub',
  'sql-seed:notify': 'hub',
  'sim:seed': 'hub',
  'spoke:init': 'spoke',
  'redis-acl:seed': 'spoke',
  'zone-crypto:mint-tokens': 'spoke',
  'zone-crypto:seed-bmc': 'spoke',
};

function rollup(healths: string[]): StepState | null {
  if (healths.length === 0) return null;
  if (healths.some((h) => h === 'failed' || h === 'crashlooping' || h === 'missing')) return 'failed';
  if (healths.every((h) => h === 'up')) return 'done';
  if (healths.some((h) => h === 'up' || h === 'unhealthy' || h === 'blocked')) return 'active';
  return 'pending';
}

/** `pending` is not outstanding work — `hub:init` is skipped by its own fingerprint guard on most
 *  bring-ups, so counting it would hold the tier short of done forever. */
function withInit(state: StepState | null, tasks: InitTask[]): StepState | null {
  if (state === null) return null;
  if (tasks.some((t) => t.state === 'failed')) return 'failed';
  if (state !== 'failed' && tasks.some((t) => t.state === 'running')) return 'active';
  return state;
}

export function deriveStackStatus(
  datastores: DatastoreLike[],
  services: Service[],
  hasActiveRun: boolean,
  pending: ReadonlySet<string> = new Set(),
  initTasks: InitTask[] = [],
): StackStatus {
  const initFor = (tier: 'hub' | 'spoke') => initTasks.filter((t) => INIT_TIER[t.name] === tier);
  const dsState = (d: DatastoreLike) => (pending.has(d.id) ? 'unhealthy' : d.status);
  const svcHealths = (group: Service['group']) =>
    services
      .filter((s) => s.group === group && s.health !== 'disabled')
      .map((s) => (pending.has(s.id) ? 'unhealthy' : s.health));

  // A starting-but-still-disabled datastore must stay in the rollup so the tier can't reach 'done' mid-op.
  const enabledDs = datastores.filter((d) => d.status !== 'disabled' || pending.has(d.id));
  const tiers: { key: string; label: string; state: StepState | null }[] = [
    {
      key: 'datastores',
      label: 'datastores',
      state: rollup(enabledDs.map(dsState)),
    },
    { key: 'hub', label: 'hub', state: withInit(rollup(svcHealths('hub')), initFor('hub')) },
    { key: 'spoke', label: 'spoke', state: withInit(rollup(svcHealths('spoke')), initFor('spoke')) },
  ];

  const steps: Step[] = tiers
    .filter((t): t is { key: string; label: string; state: StepState } => t.state !== null)
    .map((t) => ({ key: t.key, label: t.label, state: t.state }));

  const done = steps.filter((s) => s.state === 'done').length;
  const pct = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0;

  // A transient failed tier must not flip the card red while an op is in flight — coming-up wins.
  const opInFlight = hasActiveRun || pending.size > 0;
  const health: StackHealth =
    steps.length > 0 && done === steps.length
      ? 'ready'
      : opInFlight
        ? 'coming-up'
        : steps.some((s) => s.state === 'failed')
          ? 'failed'
          : steps.some((s) => s.state === 'active')
            ? 'coming-up'
            : 'stopped';

  const failedLabels = steps.filter((s) => s.state === 'failed').map((s) => s.label);
  const blocker = steps.find((s) => s.state === 'active') ?? steps.find((s) => s.state === 'pending');
  // an init task the tier is waiting on names the real blocker; a bare tier name hides it.
  const blockingInit =
    blocker?.key === 'hub' || blocker?.key === 'spoke'
      ? initFor(blocker.key).find((t) => t.state === 'running')
      : undefined;
  const detail =
    health === 'failed'
      ? `degraded — ${failedLabels.join(', ')} failing`
      : health === 'ready'
        ? 'control plane ready'
        : health === 'coming-up'
          ? `${blocker?.label ?? 'control plane'} coming up${blockingInit ? ` — ${blockingInit.label}` : ''}`
          : 'control plane stopped';

  return { health, pct, steps, detail };
}

export function StackStatusCard({
  datastores,
  services,
  activeRun,
  busy,
  pending,
  initTasks,
  onReconcile,
  onCancel,
  onViewRun,
}: {
  datastores: DatastoreLike[];
  services: Service[];
  activeRun?: Run | null;
  busy?: boolean;
  pending?: ReadonlySet<string>;
  initTasks?: InitTask[];
  onReconcile: () => void;
  onCancel: (runId: string) => void;
  onViewRun?: (runId: string) => void;
}) {
  const { health, pct, steps, detail } = deriveStackStatus(datastores, services, !!activeRun, pending, initTasks);
  const failed = health === 'failed';
  const elapsed = activeRun ? Math.max(0, Math.round((Date.now() - activeRun.startedAt) / 1000)) : 0;
  const shownDetail = activeRun ? `${activeRun.opId} running · ${elapsed}s` : detail;
  const actions = activeRun ? (
    <>
      <button
        onClick={() => onCancel(activeRun.runId)}
        className="bg-status-offline/15 text-status-offline hover:bg-status-offline/25 rounded px-2 py-1 text-[11px]"
        title="SIGTERM the orchestration child"
      >
        Stop
      </button>
      {onViewRun && (
        <button
          onClick={() => onViewRun(activeRun.runId)}
          className="border-border-dim text-text-muted hover:bg-hover-bg rounded border px-2 py-1 text-[11px]"
        >
          view logs
        </button>
      )}
    </>
  ) : health !== 'ready' ? (
    <button
      onClick={onReconcile}
      disabled={busy}
      className="bg-accent/20 text-accent hover:bg-accent/30 rounded px-2 py-1 text-[11px] disabled:opacity-40"
    >
      Reconcile
    </button>
  ) : undefined;
  return (
    <StatusCard title="Stack" ui={FLEET_HEALTH_UI[health]} detail={shownDetail} failed={failed} actions={actions}>
      {health === 'coming-up' && steps.length > 0 && <StagedProgress steps={steps} pct={pct} />}
    </StatusCard>
  );
}
