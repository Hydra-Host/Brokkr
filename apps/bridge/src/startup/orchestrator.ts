import { getErrorMessage } from '../common/error-utils';
import { STARTUP_LOGGER, type StartupLogger } from './startup-deps.types.js';

export interface BlockingTask {
  name: string;
  run(jobId: string): Promise<void>;
}

export interface BackgroundService {
  name: string;
  start(jobId: string): Promise<void> | void;
  stop(jobId: string): Promise<void> | void;
}

interface StartedEntry {
  service: BackgroundService;
  cancelling: boolean;
  terminated: boolean;
}

export class StartupOrchestrator {
  private readonly prelude: BlockingTask[] = [];
  private readonly blocking: BlockingTask[] = [];
  private readonly background: BackgroundService[] = [];
  private readonly started: StartedEntry[] = [];
  private readonly holds: Promise<void>[] = [];
  private readonly logger: StartupLogger;

  constructor(logger: StartupLogger = STARTUP_LOGGER) {
    this.logger = logger;
  }

  addPreludeBlockingTask(task: BlockingTask): void {
    this.prelude.push(task);
  }

  addBlockingTask(task: BlockingTask): void {
    this.blocking.push(task);
  }

  addBackgroundService(service: BackgroundService): void {
    this.background.push(service);
  }

  async runBlockingTasks(jobId: string): Promise<void> {
    for (const task of this.prelude) {
      await task.run(jobId);
    }
    for (const task of this.blocking) {
      try {
        this.logger.info(`Running blocking task: ${task.name}`, { jobId });
        await task.run(jobId);
        this.logger.info(`Completed blocking task: ${task.name}`, { jobId });
      } catch (exc) {
        this.logger.error(`Blocking task '${task.name}' failed: ${getErrorMessage(exc)}`, { jobId });
        throw exc;
      }
    }
  }

  async startBackgroundServices(jobId: string): Promise<void> {
    for (const service of this.background) {
      await logInfoSafe(this.logger, `Starting background task: ${service.name}`, { jobId });

      const entry: StartedEntry = { service, cancelling: false, terminated: false };

      this.started.push(entry);
      const supervised = Promise.resolve().then(() => this.runSupervised(service, jobId, entry));
      this.holds.push(supervised);

      this.logger.info(`Background task '${service.name}' launched and running independently`, { jobId });
    }
  }

  private async runSupervised(service: BackgroundService, jobId: string, entry: StartedEntry): Promise<void> {
    this.logger.info(`Background task '${service.name}' execution started`, { jobId });
    try {
      await service.start(jobId);
      entry.terminated = true;
      try {
        if (entry.cancelling) {
          this.logger.warn(`Background task '${service.name}' was cancelled`, { jobId });
          this.logger.warn(`Background task '${service.name}' was cancelled externally`, { jobId });
        } else {
          this.logger.info(`Background task '${service.name}' completed successfully`, { jobId });
          this.logger.info(`Background task '${service.name}' monitoring confirms successful completion`, { jobId });
        }
      } catch (logExc) {
        try {
          this.logger.warn(`Error monitoring task '${service.name}': ${getErrorMessage(logExc)}`, { jobId });
        } catch {
          // If logging itself fails, swallow rather than crash the orchestrator.
        }
      }
    } catch (exc) {
      entry.terminated = true;
      try {
        this.logger.warn(`Background task '${service.name}' failed: ${getErrorMessage(exc)}`, { jobId });
      } catch (logExc) {
        try {
          this.logger.warn(`Error monitoring task '${service.name}': ${getErrorMessage(logExc)}`, { jobId });
        } catch {
          // If logging itself fails, swallow rather than crash the orchestrator.
        }
      }
    }
  }

  async stopAll(jobId: string): Promise<void> {
    for (const entry of [...this.started].reverse()) {
      const { service, terminated } = entry;
      if (!terminated) entry.cancelling = true;
      try {
        await service.stop(jobId);
      } catch (error) {
        this.logger.warn(`Background task '${service.name}' stop failed: ${getErrorMessage(error)}`, { jobId });
      }
    }
    this.started.length = 0;
  }
}

async function logInfoSafe(logger: StartupLogger, message: string, context: { jobId: string }): Promise<void> {
  try {
    logger.info(message, context);
  } catch (error) {
    void error;
  }
}
