import { Injectable, Optional } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import { ContextLogger } from '../logger/logger.service';

import type { JobName } from './bullmq.types';
import type { JobHandler } from './handlers.service';

export interface QueueCounts {
  queued: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueStateInfo extends Partial<QueueCounts> {
  queue_name: string;
  error?: string;
}

export interface QueueStatesReport {
  backend: 'redis';
  queue_mode: string;
  queues: QueueStateInfo[];
}

const ZERO_COUNTS: QueueCounts = {
  queued: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
};

export interface CountableQueue {
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
}

export async function getQueueCounts(queue: CountableQueue): Promise<QueueCounts> {
  try {
    const counts = await queue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
    return {
      queued: counts.wait ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch {
    return { ...ZERO_COUNTS };
  }
}

export interface QueueSource {
  label: string;
  getQueue(): Promise<CountableQueue | null>;
}

export interface QueueModeConfig {
  queueMode: string;
}

@Injectable()
export class BullmqRegistryService {
  private readonly logger: ContextLogger;
  private readonly handlers = new Map<string, JobHandler>();

  constructor(@Optional() logger?: ContextLogger) {
    this.logger = logger ?? new ContextLogger();
  }

  register(jobName: JobName, handler: JobHandler): void {
    this.handlers.set(jobName, handler);
  }

  getHandler(jobName: string): JobHandler | undefined {
    return this.handlers.get(jobName);
  }

  getHandlers(): Record<string, JobHandler> {
    return Object.fromEntries(this.handlers);
  }

  async collectQueueStates(sources: QueueSource[], config: QueueModeConfig): Promise<QueueStatesReport> {
    const queues: QueueStateInfo[] = [];
    for (const source of sources) {
      try {
        const queue = await source.getQueue();
        if (queue === null) continue;
        const counts = await getQueueCounts(queue);
        queues.push({ queue_name: source.label, ...counts });
      } catch (exc) {
        const message = getErrorMessage(exc);
        void this.logger.warning(`Failed to collect queue state for '${source.label}': ${message}`);
        queues.push({ queue_name: source.label, error: message });
      }
    }
    return {
      backend: 'redis',
      queue_mode: config.queueMode,
      queues,
    };
  }
}
