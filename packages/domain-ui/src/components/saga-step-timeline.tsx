import type { LifecycleJobEvent } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { cn } from '@repo/ui/utils';
import { foldSagaSteps, formatDuration, groupSagaRuns, sagaRunOutcome, type SagaStep } from '@repo/utils';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StepIcon } from './step-icon';

export const SKEW_NOTE_MS = 5_000;

function formatElapsed(ms: number): string {
  if (ms < 1000) return '< 1 s';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(Math.floor(ms / 1000));
}

function formatRunning(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : formatDuration(seconds);
}

// useCountdown counts down to one deadline and stops itself; this is one clock shared by every running step
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function stepTiming(step: SagaStep, now: number): string | null {
  if (step.durationMs !== null) return formatElapsed(step.durationMs);
  if (step.status === 'running') return `running for ${formatRunning(now - new Date(step.startedAt).getTime())}`;
  return null;
}

function skewNote(step: SagaStep): string | null {
  if (step.skewMs === null || Math.abs(step.skewMs) <= SKEW_NOTE_MS) return null;
  return `skew ${(step.skewMs / 1000).toFixed(1)} s`;
}

function hasResult(step: SagaStep): boolean {
  return step.result !== null && step.result !== undefined;
}

function hasDetail(step: SagaStep): boolean {
  return hasResult(step) || step.error !== null || skewNote(step) !== null;
}

const ROW_CLASS = 'grid w-full grid-cols-[16px_1fr_max-content_16px] items-start gap-3 py-2 text-left text-sm';

function StepRow({
  step,
  now,
  expanded,
  onToggle,
}: {
  step: SagaStep;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailed = hasDetail(step);
  const summary = (
    <>
      <StepIcon status={step.status} className="mt-0.5" />
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {step.operation === null ? (
          <span className="font-mono">{step.stepName}</span>
        ) : (
          <>
            <span>{step.operation}</span>
            <span className="text-muted-foreground font-mono text-xs">{step.stepName}</span>
          </>
        )}
        {step.attempt > 0 && (
          <Badge variant="outline" size="sm">
            attempt {step.attempt + 1}
          </Badge>
        )}
        {step.origin === 'hub' && (
          <Badge variant="outline" size="sm">
            hub
          </Badge>
        )}
      </span>
      <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
        <time dateTime={step.startedAt}>{new Date(step.startedAt).toLocaleTimeString()}</time>
        <span className="block">{stepTiming(step, now)}</span>
      </span>
      {detailed ? (
        <ChevronRight
          className={cn('text-muted-foreground mt-0.5 h-4 w-4 transition-transform', expanded && 'rotate-90')}
        />
      ) : (
        <span />
      )}
    </>
  );
  return (
    <li>
      {detailed ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(ROW_CLASS, 'hover:bg-muted/50 rounded-sm')}
        >
          {summary}
        </button>
      ) : (
        <div className={ROW_CLASS}>{summary}</div>
      )}
      {detailed && expanded && (
        <div className="space-y-1 pb-2 pl-7">
          {step.error && <p className="text-destructive text-sm whitespace-pre-wrap">{step.error}</p>}
          {skewNote(step) && <p className="text-muted-foreground text-xs">{skewNote(step)}</p>}
          {hasResult(step) && (
            <pre className="bg-muted max-h-48 overflow-auto rounded-sm p-2 font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(step.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function SagaRunSection({
  sagaName,
  steps,
  outcome,
  ordinal,
  now,
}: {
  sagaName: string;
  steps: SagaStep[];
  outcome: ReturnType<typeof sagaRunOutcome>;
  ordinal: string;
  now: number;
}) {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const detailKeys = steps.filter(hasDetail).map((step) => step.key);
  const allExpanded = detailKeys.length > 0 && detailKeys.every((key) => expandedKeys.has(key));
  const bridgeSteps = steps.filter((step) => step.origin === 'bridge').length;

  const toggle = (key: string) =>
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-muted-foreground font-mono text-xs">
          {`${sagaName} · ${bridgeSteps} ${bridgeSteps === 1 ? 'step' : 'steps'}${ordinal}`}
        </h4>
        {detailKeys.length > 0 && (
          <button
            type="button"
            className="text-muted-foreground text-xs underline"
            onClick={() => setExpandedKeys(allExpanded ? new Set() : new Set(detailKeys))}
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      <ol className="divide-y">
        {steps.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            now={now}
            expanded={expandedKeys.has(step.key)}
            onToggle={() => toggle(step.key)}
          />
        ))}
      </ol>
      {outcome && (
        <p
          className={cn(
            'mt-2 font-mono text-xs',
            outcome.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {outcome.status === 'complete'
            ? `saga complete at ${new Date(outcome.at).toLocaleTimeString()}`
            : outcome.error
              ? `saga failed: ${outcome.error}`
              : 'saga failed'}
        </p>
      )}
    </section>
  );
}

export function SagaStepTimeline({
  events,
  truncated,
  cap,
}: {
  events: LifecycleJobEvent[];
  truncated: boolean;
  cap: number;
}) {
  const runs = groupSagaRuns(events).map((run) => ({
    sagaName: run.sagaName,
    steps: foldSagaSteps(run.events),
    outcome: sagaRunOutcome(run.events),
  }));
  const now = useNow(runs.some((run) => run.steps.some((step) => step.status === 'running')));
  return (
    <div className="space-y-4">
      {runs.map((run, index) => (
        <SagaRunSection
          key={`${run.sagaName}-${index}`}
          sagaName={run.sagaName}
          steps={run.steps}
          outcome={run.outcome}
          ordinal={runs.length > 1 ? ` · run ${index + 1} of ${runs.length}` : ''}
          now={now}
        />
      ))}
      {truncated && (
        <p className="text-muted-foreground text-sm">Showing the first {cap} events; newer events are omitted.</p>
      )}
    </div>
  );
}
