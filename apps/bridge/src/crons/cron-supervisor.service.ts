import { logInfo, logWarning } from '../logger/logger.service.js';

import { PeriodicTask, type CronSpec, type CronState } from './cron-base.js';
import { allSpecs } from './cron-registry.js';

function reprError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.constructor.name}(${JSON.stringify(error.message)})`;
  }
  return String(error);
}

export class CronSupervisor {
  readonly tasks: Map<string, PeriodicTask> = new Map();

  async startAll(): Promise<void> {
    for (const spec of allSpecs()) {
      const task = new PeriodicTask(spec);
      this.tasks.set(spec.name, task);
      await task.start();
      await logInfo(`cron '${spec.name}' started (interval=${spec.intervalMs / 1000}s)`, {
        jobId: `cron-${spec.name}`,
      });
    }
  }

  async stopAll(): Promise<void> {
    if (this.tasks.size === 0) return;
    const entries = Array.from(this.tasks.entries());
    const results = await Promise.allSettled(entries.map(([, task]) => task.stop()));
    for (let i = 0; i < entries.length; i += 1) {
      const [name] = entries[i];
      const result = results[i];
      if (result.status === 'rejected') {
        await logWarning(`cron '${name}' stop raised ${reprError(result.reason)}`, {
          jobId: `cron-${name}`,
        });
      }
    }
  }

  states(): CronState[] {
    return Array.from(this.tasks.values()).map((task) => task.state);
  }
}

export type { CronSpec, CronState };
