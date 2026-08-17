import type { FleetStatus } from '@/contract';

export type HealthUi = { dot: string; text: string; note: string };

export const HEALTH_UI: Record<string, HealthUi> = {
  up: { dot: 'bg-status-online', text: 'text-status-online', note: 'ready' },
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
  pending: { dot: 'bg-text-label', text: 'text-text-dim', note: 'not run' },
};
export const RUNNING_HEALTH = ['up', 'unhealthy', 'crashlooping'];
export const healthUi = (status: string): HealthUi =>
  HEALTH_UI[status] ?? { dot: 'bg-status-offline', text: 'text-status-offline', note: status };

export const FLEET_HEALTH_UI: Record<FleetStatus['health'], HealthUi> = {
  ready: { dot: 'bg-status-online', text: 'text-status-online', note: 'ready' },
  'coming-up': { dot: 'bg-status-info animate-pulse', text: 'text-status-info', note: 'coming up' },
  stopped: { dot: 'bg-text-dim', text: 'text-text-muted', note: 'stopped' },
  failed: { dot: 'bg-status-offline', text: 'text-status-offline', note: 'failed' },
  disabled: { dot: 'bg-text-label', text: 'text-text-dim', note: 'disabled' },
  idle: { dot: 'bg-text-dim', text: 'text-text-muted', note: 'not started' },
};
