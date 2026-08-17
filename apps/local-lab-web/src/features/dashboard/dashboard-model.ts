import { deriveStackStatus, type StackStatus } from '@/components/status/stack-status-card';
import type { StepState } from '@/components/status/staged-progress';
import type { FleetSummary, HttpProbeResult, InitStatus, InitTask, Run, Service, Status } from '@/contract';
import { fmtAgo } from '@/lib/format';

export interface StageSubline {
  text: string;
  failed: boolean;
}

export interface PipelineStage {
  key: string;
  label: string;
  state: StepState;
  sublines: StageSubline[];
}

export interface HeroModel {
  stack: StackStatus;
  stages: PipelineStage[];
  line: { text: string; failed: boolean };
  directive: boolean;
}

export const POWER_DOT: Record<Status['fleet'][number]['power'], string> = {
  on: 'bg-status-online',
  off: 'bg-text-dim',
  unknown: 'bg-status-warning',
};

export const RUN_STATUS_TEXT: Record<Run['status'], string> = {
  running: 'text-status-info',
  passed: 'text-status-online',
  failed: 'text-status-offline',
  cancelled: 'text-text-dim',
};

export const RUN_STATUS_DOT: Record<Run['status'], string> = {
  running: 'bg-status-info animate-pulse',
  passed: 'bg-status-online',
  failed: 'bg-status-offline',
  cancelled: 'bg-text-dim',
};

export const STAGE_DOT: Record<StepState, string> = {
  done: 'bg-status-online',
  active: 'bg-status-info animate-pulse',
  failed: 'bg-status-offline',
  pending: 'bg-text-dim',
};

export const CONNECTOR_CLASS: Record<StepState, string> = {
  done: 'bg-status-online/50',
  active: 'bg-status-info/50 animate-pulse',
  failed: 'bg-status-offline/50',
  pending: 'bg-border-dim',
};

export const runRoute = (run: Run): '/results' | '/fleet' | '/storage' | '/datastore' | '/stack' =>
  run.section === 'test'
    ? '/results'
    : run.section === 'fleet'
      ? '/fleet'
      : run.section === 'storage'
        ? '/storage'
        : run.section === 'queues'
          ? '/datastore'
          : '/stack';

const portOf = (target: string): string | null => /:(\d+)\//.exec(target)?.[1] ?? null;

const probeLine = (label: string, probe: HttpProbeResult | undefined): StageSubline => {
  if (probe === undefined) return { text: `${label} · probe unavailable`, failed: false };
  if (probe.ok) {
    const latency = probe.latencyMs !== null ? ` · ${probe.latencyMs}ms` : '';
    return { text: `${label} · answering${latency}`, failed: false };
  }
  return { text: `${label} · ${probe.detail}`, failed: true };
};

const datastoreLine = (datastores: Status['datastores']): StageSubline => {
  const failed = !datastores.postgres || !datastores.redis;
  return {
    text: `pg ${datastores.postgres ? 'up' : 'down'} · redis ${datastores.redis ? 'up' : 'down'}`,
    failed,
  };
};

const hubLine = (hubHealth: HttpProbeResult | undefined): StageSubline =>
  probeLine(hubHealth !== undefined ? `:${portOf(hubHealth.target) ?? '?'} http` : 'hub http', hubHealth);

const spokeLines = (services: Service[], probes: HttpProbeResult[] | undefined): StageSubline[] => {
  const spokes = services.filter((s) => s.group === 'spoke');
  if (spokes.length === 0) return [];
  return spokes.map((svc) => {
    const probe = probes?.find((p) => portOf(p.target) === String(svc.port));
    return probeLine(svc.zone ?? svc.id, probe);
  });
};

// the roster only knows the process is up; the probe is what catches a booted-but-wedged http surface.
const probeFailed = (key: string, status: Status): boolean => {
  if (key === 'hub') return status.hubHealth !== undefined && !status.hubHealth.ok;
  if (key === 'spoke') return (status.spokeHealth ?? []).some((p) => !p.ok);
  return false;
};

export function deriveHero(status: Status, initTasks: InitTask[] = []): HeroModel {
  const datastores = [
    { id: 'postgres', status: status.datastores.postgres ? 'up' : 'failed' },
    { id: 'redis', status: status.datastores.redis ? 'up' : 'failed' },
  ];
  // only a stack-section op explains a transient control-plane failure — an unrelated run must not mask one
  const opInFlight = (status.recentRuns ?? []).some((r) => r.section === 'stack' && r.status === 'running');
  const stack = deriveStackStatus(datastores, status.services, opInFlight, new Set(), initTasks);
  const sublinesFor = (key: string): StageSubline[] => {
    if (key === 'datastores') return [datastoreLine(status.datastores)];
    if (key === 'hub') return [hubLine(status.hubHealth)];
    if (key === 'spoke') return spokeLines(status.services, status.spokeHealth);
    return [];
  };
  const unanswered = stack.steps.filter((step) => step.state === 'done' && probeFailed(step.key, status));
  const downgraded = new Set(unanswered.map((step) => step.key));
  const stages: PipelineStage[] = stack.steps.map((step) => ({
    key: step.key,
    label: step.label,
    state: downgraded.has(step.key) ? 'failed' : step.state,
    sublines: sublinesFor(step.key),
  }));
  const failed = stack.health === 'failed' || downgraded.size > 0;
  const line =
    downgraded.size > 0
      ? { text: `${unanswered.map((step) => step.label).join(', ')} up but not answering`, failed: true }
      : { text: stack.detail, failed: stack.health === 'failed' };
  return { stack, stages, line, directive: failed };
}

export function fleetSummaryLine(summary: FleetSummary): string {
  const lifecycle = Object.entries(summary.byLifecycle).map(([status, count]) => `${count} ${status}`);
  return [`${summary.on}/${summary.total} on`, ...lifecycle].join(' · ');
}

export function footerParts(status: Status, now: number = Date.now()): string[] {
  const { ccBuild } = status.app;
  const parts = [`cc ${ccBuild.sha?.slice(0, 7) ?? 'dev'}`];
  if (ccBuild.builtAt !== null) parts.push(`built ${fmtAgo(ccBuild.builtAt, now)}`);
  parts.push(`api up ${fmtAgo(status.app.startedAt, now)}`);
  return parts;
}

export function initSummaryLine(init: InitStatus): string {
  const counted = `${init.completed}/${init.total} completed`;
  return init.current === null ? counted : `${init.current} · ${counted}`;
}
