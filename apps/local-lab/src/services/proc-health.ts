/** The bash half of this taxonomy is apps/local-sim/scripts/tasks/stack-reconcile.sh — the two must agree on "up" and "terminal". */

export interface PcProcess {
  name: string;
  // Optional fields are `| null` too: process-compose emits null (not just omission) for unset
  // scalars, and PcProcessSchema mirrors that with `.nullish()` (see common/pc-schemas.ts).
  namespace?: string | null;
  status: string; // "Running" | "Completed" | "Disabled" | "Pending" | "Error" | …
  is_ready?: string | null; // "Ready" | "Not Ready" | "-"
  pid?: number | null;
  restarts?: number | null;
  exit_code?: number | null;
  replica?: number | null;
  has_ready_probe?: boolean | null;
  cpu?: number | null;
  mem?: number | null;
  system_time?: string | null;
}

export type ProcHealth = 'up' | 'unhealthy' | 'crashlooping' | 'failed' | 'blocked' | 'down' | 'disabled' | 'missing';

export interface ProcDiag {
  status: ProcHealth;
  restarts?: number;
  exitCode?: number;
  detail?: string;
}

/** Deliberately below devenv's `availability.max_restarts = 5` — at the cap the process is already terminal, so the warning would never show. */
export const CRASHLOOP_RESTARTS = 3;

/** 128+signum exits (SIGINT/SIGKILL/SIGTERM) — pc reports these when it stops/restarts a process, so they mean "stopped", not "crashed". */
export const STOP_SIGNAL_EXIT_CODES = new Set([130, 137, 143]);

// A genuine error (crash), not a clean stop/restart. Shared by classifyProc + deriveFleetStatus so
// the services and fleet health views agree on what counts as a crash.
export function isErrorExit(exitCode?: number | null): boolean {
  // > 0 (not !== 0): a signal kill can surface as a negative code (e.g. -1 on cancel) — also a stop.
  return exitCode != null && exitCode > 0 && !STOP_SIGNAL_EXIT_CODES.has(exitCode);
}

/** Lenient on is_ready (a probe-less process reports "-" yet is up) — must stay in lockstep with `is_up()` in stack-reconcile.sh. */
export function procIsUp(p: PcProcess | undefined): boolean {
  if (!p) return false;
  const s = (p.status ?? '').toLowerCase();
  const r = (p.is_ready ?? '').toLowerCase();
  return s === 'running' && r !== 'not ready';
}

/** Stricter than `procIsUp`, and for one reason: a dependent (re)created while its dependency still
 *  reports "-" is left Skipped for good. `dep_ready()` in stack-reconcile.sh is the bash half. */
export function procIsDepReady(p: PcProcess | undefined): boolean {
  if (!p) return false;
  if ((p.status ?? '').toLowerCase() !== 'running') return false;
  const r = (p.is_ready ?? '').toLowerCase();
  return p.has_ready_probe ? r === 'ready' : r !== 'not ready';
}

export function depsReady(name: string, byName: Map<string, PcProcess>, graph: Record<string, string[]>): boolean {
  return (graph[name] ?? []).every((d) => {
    const dp = byName.get(d);
    if (!dp) return true;
    if ((dp.status ?? '').toLowerCase() === 'disabled') return true;
    return procIsUp(dp);
  });
}

/** Must stay pure + cheap (no I/O) — called for every process on each status poll. */
export function classifyProc(p: PcProcess | undefined, deps: boolean): ProcDiag {
  if (!p) return { status: 'missing' };
  const s = (p.status ?? '').toLowerCase();
  const restarts = typeof p.restarts === 'number' ? p.restarts : undefined;
  const exitCode = typeof p.exit_code === 'number' ? p.exit_code : undefined;
  const base = { restarts, exitCode };
  if (s === 'disabled') return { status: 'disabled', ...base };
  if (s === 'running') {
    if (procIsUp(p)) return { status: 'up', ...base };
    if ((restarts ?? 0) >= CRASHLOOP_RESTARTS)
      return { status: 'crashlooping', detail: `restarted ${restarts}× and still not ready`, ...base };
    return { status: 'unhealthy', detail: 'running — waiting to become ready', ...base };
  }
  if (!deps)
    return { status: 'blocked', detail: 'a dependency is not ready — start it first (or run Reconcile)', ...base };
  const failed = s === 'error' || isErrorExit(exitCode) || (restarts ?? 0) >= CRASHLOOP_RESTARTS;
  if (failed) {
    const why =
      exitCode != null ? `exited ${exitCode}${(restarts ?? 0) > 0 ? ` after ${restarts} restarts` : ''}` : 'crashed';
    return { status: 'failed', detail: why, ...base };
  }
  return { status: 'down', ...base };
}
