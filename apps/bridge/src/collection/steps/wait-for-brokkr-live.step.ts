import { Injectable } from '@nestjs/common';

import type {
  BrokkrLiveDiagnosticCheck,
  BrokkrLiveReadinessDiagnostic,
} from '../../brokkr-live/brokkr-live-readiness.service';
import type { BmcCredentials } from '../../common/bmc.types';
import { getErrorMessage } from '../../common/error-utils';
import { credsFromContext } from '../../oob/steps/power-control-context';
import type {
  PowerManagementServiceFactoryLike,
  PowerManagementServiceLike,
} from '../../oob/steps/power-management-service.types';
import { skipIfBrokkrLiveReady, type SkipResult } from '../../saga-framework/brokkr-live-skip';
import type { SagaContext } from '../../saga-framework/saga.types';

interface ReadinessServiceLike {
  waitForBrokkrLive(
    deviceId: string,
    opts?: {
      initialDelay?: number;
      diagnosticCheck?: BrokkrLiveDiagnosticCheck;
    },
  ): Promise<boolean>;
}

interface ReadinessServiceFactoryLike {
  create(jobId: string): Promise<ReadinessServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
}

type WaitResult = { os_ready: true };
type StepResult = SkipResult | WaitResult;

@Injectable()
export class WaitForBrokkrLiveStep {
  constructor(
    private readonly factory: ReadinessServiceFactoryLike,
    private readonly logger: LoggerLike,
    private readonly powerFactory?: PowerManagementServiceFactoryLike,
  ) {}

  async execute(ctx: SagaContext): Promise<StepResult> {
    const skip = skipIfBrokkrLiveReady(ctx);
    if (skip !== null) return skip;

    const jobId = ctx.jobId;
    await this.logger.info('Waiting for Brokkr Live OS', { jobId });

    const service = await this.factory.create(jobId);
    const ready = await service.waitForBrokkrLive(String(ctx.deviceId), {
      diagnosticCheck: this.buildPowerOnDiagnostic(ctx),
    });

    if (!ready) {
      throw new Error('Brokkr Live OS did not become ready');
    }

    await this.logger.info('Brokkr Live OS ready', { jobId });
    return { os_ready: true };
  }

  private buildPowerOnDiagnostic(ctx: SagaContext): (() => Promise<BrokkrLiveReadinessDiagnostic>) | undefined {
    const powerFactory = this.powerFactory;
    if (powerFactory === undefined) return undefined;

    let creds: BmcCredentials;
    try {
      creds = credsFromContext(ctx);
    } catch {
      return undefined;
    }

    let servicePromise: Promise<PowerManagementServiceLike> | null = null;
    return async () => {
      try {
        servicePromise ??= powerFactory.create(ctx.jobId);
        const power = await servicePromise;
        await power.verifyPowerOn(creds, { timeout: 1, pollInterval: 1 });
        return { ok: true };
      } catch (error) {
        // A thrown verifyPowerOn is inconclusive, not broken-boot-chain evidence — transient IPMI errors must not abort provisioning.
        return { ok: false, inconclusive: true, reason: `BMC power-on verification failed: ${getErrorMessage(error)}` };
      }
    };
  }
}
