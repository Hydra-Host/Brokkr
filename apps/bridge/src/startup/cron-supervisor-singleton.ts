import { CronSupervisor } from '../crons/cron-supervisor.service.js';

import type { CronSupervisorLike } from './startup-services.js';

let instance: CronSupervisorLike | null = null;
let factory: () => CronSupervisorLike = (): CronSupervisorLike => new CronSupervisor();

export function configureCronSupervisor(make: () => CronSupervisorLike): void {
  factory = make;
}

export function getCronSupervisor(): CronSupervisorLike {
  if (instance === null) {
    instance = factory();
  }
  return instance;
}

export function resetCronSupervisorForTests(): void {
  instance = null;
  factory = (): CronSupervisorLike => new CronSupervisor();
}
