import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';

import type { SagaContext } from '../../saga-framework/saga.types';
import { forwardedSecretSchema, openBmcSecret } from '../../zone-crypto/device-secret-open';

interface DeviceHealthServiceLike {
  checkDeviceHealth(args: {
    deviceId: string;
    bmcIp: unknown;
    primaryIp: unknown;
    username: unknown;
    password: unknown;
  }): Promise<Record<string, unknown> | null>;
}

interface DeviceHealthServiceFactoryLike {
  create(jobId: string): Promise<DeviceHealthServiceLike>;
}

@Injectable()
export class CheckDeviceHealthStep {
  constructor(private readonly factory: DeviceHealthServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | null> {
    const payload = ctx.payload;
    const service = await this.factory.create(ctx.jobId);

    let username = '';
    let password = '';
    const sealed = forwardedSecretSchema.safeParse(isRecord(payload.secrets) ? payload.secrets.bmc : undefined);
    if (sealed.success) {
      const opened = openBmcSecret(sealed.data);
      username = opened.username;
      password = opened.password;
    }

    return service.checkDeviceHealth({
      deviceId: String('device_id' in payload ? payload.device_id : ''),
      bmcIp: 'bmc_ip' in payload ? payload.bmc_ip : null,
      primaryIp: 'primary_ip' in payload ? payload.primary_ip : null,
      username,
      password,
    });
  }
}
