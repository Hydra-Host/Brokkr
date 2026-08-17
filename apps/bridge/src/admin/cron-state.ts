export interface CronStateSnapshot {
  name: string;
  intervalSeconds: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  running: boolean;
}

export interface CronStateProvider {
  states(): readonly CronStateSnapshot[];
}

export const CRON_STATE_PROVIDER = 'CRON_STATE_PROVIDER';

export const emptyCronStateProvider: CronStateProvider = {
  states: () => [],
};

export interface CronStateSupervisorLike {
  states(): readonly CronStateSnapshot[];
}

export function supervisorCronStateProvider(supervisor: CronStateSupervisorLike): CronStateProvider {
  return { states: () => supervisor.states() };
}
