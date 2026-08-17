import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import { isRecord } from '@repo/utils';

import { RedfishDevice } from '../../redfish/index.js';
import type { SagaContext } from '../../saga-framework/saga.types';
import type { RedfishCommandKwargs, RedfishService } from '../redfish.service';
import { credsFromContext } from './power-control-context';

interface RedfishServiceFactoryLike {
  create(args: { jobId: string }): Promise<RedfishService>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

@Injectable()
export class RedfishCommandStep {
  constructor(
    private readonly factory: RedfishServiceFactoryLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const { payload, jobId } = ctx;
    const commandRaw: unknown = payload['command'];
    if (
      commandRaw === null ||
      commandRaw === undefined ||
      commandRaw === '' ||
      commandRaw === 0 ||
      commandRaw === false
    ) {
      throw new Error('No Redfish command specified in payload');
    }
    const commandStr = String(commandRaw);

    const rawDeviceId = payload['device_id'];
    const deviceId =
      rawDeviceId !== null &&
      rawDeviceId !== undefined &&
      rawDeviceId !== '' &&
      rawDeviceId !== false &&
      rawDeviceId !== 0
        ? String(rawDeviceId)
        : String(ctx.deviceId);

    const creds = credsFromContext(ctx);
    const device = new RedfishDevice(jobId, deviceId, creds.bmcIp, creds.username, creds.password);

    const service = await this.factory.create({ jobId });

    if (!service.hasCommand(commandStr)) {
      throw new Error(`Unknown Redfish command: ${commandStr}`);
    }

    await this.logger.info(`Executing Redfish command '${commandStr}'`, { jobId });

    try {
      const innerPayload = payload['kwargs'] ?? {};
      const kwargs: RedfishCommandKwargs = { payload: innerPayload };
      const result = await service.execute(commandStr, device, kwargs);
      await this.logger.info(`Redfish command '${commandStr}' completed`, { jobId });
      return isRecord(result) ? result : { success: true };
    } catch (error) {
      const detail = getErrorMessage(error);
      await this.logger.error(`Redfish command '${commandStr}' failed: ${detail}`, { jobId });
      throw new Error(`Redfish command '${commandStr}' failed: ${detail}`);
    }
  }
}
