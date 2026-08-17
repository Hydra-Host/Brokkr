import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import type { SagaContext } from '../../saga-framework/saga.types';

interface BrokkrLiveServiceLike {
  testDeviceConnectivity(deviceId: string): Promise<{ connected: boolean }>;
}

interface BrokkrLiveServiceFactoryLike {
  create(jobId: string): Promise<BrokkrLiveServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

@Injectable()
export class BrokkrLiveCheckStep {
  constructor(
    private readonly factory: BrokkrLiveServiceFactoryLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<{ ready: boolean }> {
    const deviceId = String(ctx.deviceId);
    const { jobId } = ctx;

    let connectivity: { connected: boolean };
    try {
      const service = await this.factory.create(jobId);
      connectivity = await service.testDeviceConnectivity(deviceId);
    } catch (error) {
      await this.logger.warning(
        `Brokkr Live readiness probe failed for device ${deviceId}: ${getErrorMessage(error)}`,
        { jobId },
      );
      return { ready: false };
    }

    if (connectivity.connected) {
      await this.logger.info(`Brokkr Live OS running on device ${deviceId}`, { jobId });
      return { ready: true };
    }

    await this.logger.warning(`Brokkr Live not ready: agent unreachable on device ${deviceId}`, { jobId });
    return { ready: false };
  }
}
