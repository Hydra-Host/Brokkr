import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';

import { ContextLogger } from '../../logger/logger.service';

export class CloudInitPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudInitPayloadError';
  }
}

export interface PhoneHomeCreds {
  deployment_os_token: string;
  endpoint: string;
}

export interface BuildPhoneHomeCredsArgs {
  deviceId: string;
  jobId: string;
  serverToken: unknown;
}

@Injectable()
export class CloudInitPayloadService {
  constructor(private readonly logger: ContextLogger) {}

  async buildPhoneHomeCreds(args: BuildPhoneHomeCredsArgs): Promise<PhoneHomeCreds> {
    const { deviceId, jobId, serverToken } = args;

    if (!isRecord(serverToken)) {
      throw new CloudInitPayloadError(
        `server_token missing from saga payload for device ${deviceId} (hub must mint it before enqueuing the provision saga)`,
      );
    }

    const token = serverToken['deployment_os_token'];
    const endpoint = serverToken['endpoint'];
    if (typeof token !== 'string' || token === '' || typeof endpoint !== 'string' || endpoint === '') {
      throw new CloudInitPayloadError(
        `server_token for device ${deviceId} is malformed: expected non-empty 'deployment_os_token' and 'endpoint' strings`,
      );
    }

    await this.logger.info(`Built phone-home creds from saga payload for device ${deviceId}`, { jobId });
    return {
      deployment_os_token: token,
      endpoint,
    };
  }
}
