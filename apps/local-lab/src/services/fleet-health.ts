// Pure, dependency-free fleet bring-up classification — the fleet analogue of proc-health.ts.
// Composes process-compose state + fleet-progress.json + machine counts into one FleetStatus. No I/O.
import type { FleetProgress } from '../common/pc-schemas';
import type { BringupPhase, BringupStep, FleetHealth, FleetStatus } from '../contract';
import { isErrorExit, type PcProcess } from './proc-health';

// Taxonomy is contract-owned (Bringup{Phase,Step}/FleetHealth/FleetStatus schemas, Python-parity with
// progress.py); FleetProgress is the disk-JSON boundary shape. Re-exported so importers still resolve here.
export type { BringupPhase, BringupStep, FleetHealth, FleetProgress, FleetStatus };

export function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** A negative exit (SIGTERM stop/cancel) is `stopped`, not `failed` — only status `Error`, a positive non-zero exit, or a recorded engine error counts as a crash. */
export function deriveFleetStatus(
  p: PcProcess | undefined,
  prog: FleetProgress | null,
  machinesExpected: number,
  machinesRunning: number,
  nowMs: number,
  lastError?: string,
): FleetStatus {
  const elapsedSec = prog?.startedAt != null ? Math.max(0, Math.round(nowMs / 1000 - prog.startedAt)) : null;
  const base = {
    phase: prog?.phase ?? null,
    step: prog?.step ?? null,
    label: prog?.label ?? null,
    node: prog?.node ?? null,
    index: prog?.index ?? 0,
    total: prog?.total ?? 0,
    stepOrdinal: prog?.stepOrdinal ?? -1,
    stepCount: prog?.stepCount ?? 0,
    elapsedSec,
    machinesExpected,
    machinesRunning,
  };
  if (!p) return { ...base, health: 'idle', detail: 'not started — click Start' };
  const s = (p.status ?? '').toLowerCase();
  const ready = (p.is_ready ?? '').toLowerCase() === 'ready';
  if (s === 'disabled') return { ...base, health: 'disabled', detail: 'disabled — autoStart off' };
  if (s === 'running' && ready)
    return { ...base, health: 'ready', detail: `ready · ${machinesRunning}/${machinesExpected} VMs running` };
  if (s === 'running' || s === 'pending') {
    const label = prog?.label ?? 'starting';
    const per = prog && prog.total > 0 ? ` (${prog.index}/${prog.total})` : '';
    const el = elapsedSec != null ? ` · ${fmtElapsed(elapsedSec)}` : '';
    return { ...base, health: 'coming-up', detail: `${label}${per}${el}` };
  }
  const crashed = s === 'error' || !!prog?.error || isErrorExit(p.exit_code);
  if (crashed) return { ...base, health: 'failed', detail: prog?.error ?? lastError ?? `exited ${p.exit_code}` };
  return {
    ...base,
    health: 'stopped',
    detail: lastError ? `stopped — ${lastError}` : 'stopped before powering on — click Start',
  };
}
