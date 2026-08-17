import { BringupStepSchema, type FleetStatus } from '@/contract';

import { FLEET_HEALTH_UI } from './status/health-ui';
import { StagedProgress, type Step } from './status/staged-progress';
import { StatusCard } from './status/status-card';

export { FLEET_HEALTH_UI };

const STEP_LABEL: Partial<Record<(typeof BringupStepSchema.options)[number], string>> = {
  'build-live-img': 'images',
  'build-agent-img': 'agent',
  'build-grub': 'grub',
  prefetch: 'discovery',
  'build-ipxe': 'iPXE',
  render: 'render',
  daemons: 'daemons',
  'power-on': 'power on',
  ready: 'ready',
};
const SEQUENCE = BringupStepSchema.options.filter((s) => s in STEP_LABEL);

export function FleetStatusCard({
  fleet,
  busy,
  onStart,
  onViewLogs,
}: {
  fleet: FleetStatus;
  busy: boolean;
  onStart: () => void;
  onViewLogs?: () => void;
}) {
  const canStart = fleet.health === 'stopped' || fleet.health === 'idle' || fleet.health === 'failed';
  const failed = fleet.health === 'failed';
  const showLogs = !!onViewLogs && (failed || fleet.health === 'stopped' || fleet.health === 'coming-up');
  const actions =
    canStart || showLogs ? (
      <>
        {canStart && (
          <button
            onClick={onStart}
            disabled={busy}
            className="bg-accent/20 text-accent hover:bg-accent/30 rounded px-2 py-1 text-[11px] disabled:opacity-40"
          >
            Start fleet
          </button>
        )}
        {showLogs && (
          <button
            onClick={onViewLogs}
            className="border-border-dim text-text-muted hover:bg-hover-bg rounded border px-2 py-1 text-[11px]"
          >
            view logs
          </button>
        )}
      </>
    ) : undefined;
  return (
    <StatusCard
      title="Fleet"
      ui={FLEET_HEALTH_UI[fleet.health]}
      detail={fleet.detail}
      failed={failed}
      actions={actions}
    >
      {fleet.health === 'coming-up' && <FleetBringupProgress fleet={fleet} />}
    </StatusCard>
  );
}

export function FleetBringupProgress({ fleet }: { fleet: FleetStatus }) {
  const pct =
    fleet.stepCount > 0 && fleet.stepOrdinal >= 0 ? Math.round(((fleet.stepOrdinal + 1) / fleet.stepCount) * 100) : 0;
  const steps = SEQUENCE.map(
    (stepKey, i): Step => ({
      key: stepKey,
      label: STEP_LABEL[stepKey] ?? stepKey,
      state: fleet.step === stepKey ? 'active' : fleet.stepOrdinal > i ? 'done' : 'pending',
    }),
  );
  const subline =
    fleet.total > 0 && fleet.index > 0
      ? `${fleet.node ? `${fleet.node} · ` : ''}${fleet.index}/${fleet.total}`
      : undefined;
  return <StagedProgress steps={steps} pct={pct} subline={subline} />;
}
