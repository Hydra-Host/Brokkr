import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../../common/error-utils';

import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';

interface SolServiceLike {
  monitorSession(args: {
    planId: string;
    ipAddress: string;
    username: string;
    password: string;
    timeout: number;
  }): Promise<unknown>;
}

interface SolServiceFactoryLike {
  create(jobId: string): Promise<SolServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

interface SimModeProbe {
  isLocalSimulationEnabled(): boolean;
}

interface SolActivationResult {
  sol_activated: boolean;
  reason?: string;
}

@Injectable()
export class SolActivationStep {
  private readonly backgroundTasks = new Set<Promise<unknown>>();

  constructor(
    private readonly factory: SolServiceFactoryLike,
    private readonly logger: LoggerLike,
    private readonly simMode: SimModeProbe,
  ) {}

  async execute(ctx: SagaContext): Promise<SolActivationResult> {
    if (this.simMode.isLocalSimulationEnabled()) {
      await this.logger.info('[sim] SOL activation skipped', { jobId: ctx.jobId });
      return { sol_activated: false, reason: 'local_simulation_enabled' };
    }

    try {
      const { bmcIp, username, password } = credsFromContext(ctx);

      const service = await this.factory.create(ctx.jobId);
      const task = service.monitorSession({
        planId: ctx.planId,
        ipAddress: bmcIp,
        username,
        password,
        timeout: 300,
      });
      this.backgroundTasks.add(task);
      task
        .then(
          () => this.logger.info('SOL monitoring session ended', { jobId: ctx.jobId }),
          (taskError: unknown) =>
            this.logger.warning(`SOL monitoring session failed: ${getErrorMessage(taskError)}`, {
              jobId: ctx.jobId,
            }),
        )
        .catch(() => undefined)
        .finally(() => {
          this.backgroundTasks.delete(task);
        });
      await this.logger.info('SOL monitoring activated in background', { jobId: ctx.jobId });
      return { sol_activated: true };
    } catch (error) {
      const msg = getErrorMessage(error);
      await this.logger.warning(`SOL activation error (non-fatal): ${msg}`, {
        jobId: ctx.jobId,
      });
      return { sol_activated: false, reason: msg };
    }
  }
}
