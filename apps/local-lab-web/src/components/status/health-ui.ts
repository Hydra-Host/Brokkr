import type { FleetStatus } from '@/contract';

export type HealthUi = { dot: string; text: string; note: string };

export const UP_NO_PROBE = 'up-no-probe';

export const HEALTH_UI: Record<string, HealthUi> = {
  up: { dot: 'bg-status-online', text: 'text-status-online', note: 'ready' },
  // web-only variant: the server reports `up` for a probe-less process too, and only its `ready` field
  // separates the two. No ProcHealth value collides with this key.
  [UP_NO_PROBE]: { dot: 'bg-status-online/70', text: 'text-status-online/80', note: 'up · no probe' },
  unhealthy: { dot: 'bg-status-warning', text: 'text-status-warning', note: 'starting' },
  crashlooping: { dot: 'bg-status-price', text: 'text-status-price', note: 'crash-looping' },
  failed: { dot: 'bg-status-offline', text: 'text-status-offline', note: 'failed' },
  blocked: { dot: 'bg-status-purple', text: 'text-status-purple', note: 'blocked' },
  down: { dot: 'bg-text-dim', text: 'text-text-muted', note: 'stopped' },
  disabled: { dot: 'bg-text-label', text: 'text-text-dim', note: 'disabled' },
  missing: { dot: 'bg-status-offline', text: 'text-status-offline', note: 'no process' },
  // oneshot init-task states; no ProcHealth value collides with them.
  running: { dot: 'bg-status-info animate-pulse', text: 'text-status-info', note: 'running' },
  completed: { dot: 'bg-status-online', text: 'text-status-online', note: 'done' },
  cached: { dot: 'bg-status-online/70', text: 'text-status-online/80', note: 'cached' },
  pending: { dot: 'bg-text-label', text: 'text-text-dim', note: 'not run' },
};
// ProcHealth values only — the server never sends UP_NO_PROBE, so it has no place here.
export const RUNNING_HEALTH = ['up', 'unhealthy', 'crashlooping'];
export const healthUi = (status: string): HealthUi =>
  HEALTH_UI[status] ?? { dot: 'bg-status-offline', text: 'text-status-offline', note: status };

/** `ready` is the field that says a probe passed; a running process with none must not borrow its badge. */
export const serviceHealthUi = (svc: { health: string; ready: boolean }): HealthUi =>
  healthUi(svc.health === 'up' && !svc.ready ? UP_NO_PROBE : svc.health);

export const FLEET_HEALTH_UI: Record<FleetStatus['health'], HealthUi> = {
  ready: { dot: 'bg-status-online', text: 'text-status-online', note: 'ready' },
  degraded: { dot: 'bg-status-warning', text: 'text-status-warning', note: 'degraded' },
  'coming-up': { dot: 'bg-status-info animate-pulse', text: 'text-status-info', note: 'coming up' },
  stopped: { dot: 'bg-text-dim', text: 'text-text-muted', note: 'stopped' },
  failed: { dot: 'bg-status-offline', text: 'text-status-offline', note: 'failed' },
  disabled: { dot: 'bg-text-label', text: 'text-text-dim', note: 'disabled' },
  idle: { dot: 'bg-text-dim', text: 'text-text-muted', note: 'not started' },
};
