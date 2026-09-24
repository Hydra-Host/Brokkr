import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../../common/error-utils';

import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';
import type { EnsureSolEnabledResult } from '../sol-provisioning.service';

interface SolProvisioningServiceLike {
  ensureSolEnabled(params: {
    deviceId: string | null;
    bmcIp: string;
    username: string;
    password: string;
    port?: unknown;
  }): Promise<EnsureSolEnabledResult>;
}

interface SolProvisioningServiceFactoryLike {
  create(jobId: string): Promise<SolProvisioningServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

@Injectable()
export class EnsureSolEnabledStep {
  constructor(
    private readonly factory: SolProvisioningServiceFactoryLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const { jobId } = ctx;
    const payload = ctx.payload;
    try {
      const { bmcIp, username, password } = credsFromContext(ctx);
      const service = await this.factory.create(jobId);
      const rawDeviceId = payload['device_id'];
      const result = await service.ensureSolEnabled({
        deviceId: typeof rawDeviceId === 'string' ? rawDeviceId : null,
        bmcIp,
        username,
        password,
        port: 'port' in payload ? payload['port'] : 623,
      });
      return { sol_ready: true, ...result };
    } catch (error) {
      const msg = getErrorMessage(error);
      await this.logger.warning(`SOL prerequisite check failed (non-fatal): ${msg}`, { jobId });
      return { sol_ready: false, reason: msg };
    }
  }
}
