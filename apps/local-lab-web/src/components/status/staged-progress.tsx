export type StepState = 'pending' | 'active' | 'done' | 'failed';

export type Step = { key: string; label: string; state: StepState };

const STEP_CLASS: Record<StepState, string> = {
  active: 'bg-status-info/30 text-status-info',
  done: 'bg-status-online/15 text-status-online/80',
  failed: 'bg-status-offline/20 text-status-offline',
  pending: 'bg-hover-bg text-text-dim',
};

export function StagedProgress({ steps, pct, subline }: { steps: Step[]; pct: number; subline?: string }) {
  const anyFailed = steps.some((s) => s.state === 'failed');
  return (
    <div className="mt-2 space-y-1">
      <div className="bg-hover-bg h-1 w-full overflow-hidden rounded">
        <div
          className={`h-full transition-all ${anyFailed ? 'bg-status-offline/70' : 'bg-status-info/70'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {steps.map((step) => (
          <span key={step.key} className={`rounded px-1.5 py-0.5 text-[10px] ${STEP_CLASS[step.state]}`}>
            {step.label}
          </span>
        ))}
      </div>
      {subline && <div className="text-text-dim text-[10px]">{subline}</div>}
    </div>
  );
}
