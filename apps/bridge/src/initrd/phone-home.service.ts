import { deviceServerToken } from '../common/redis/redis-keys.js';
import type { ServerTokenAtom } from '../device-record/atom/server-token.schema.js';

import { getLogger } from '../logger/logger.service';

export class PhoneHomeCredsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneHomeCredsUnavailable';
  }
}

export interface ServerTokenAtomRequest {
  domain: string;
  entityId: string;
  atomKey: string;
  jobId: string;
}

export type ServerTokenAtomFetcher = (params: ServerTokenAtomRequest) => Promise<ServerTokenAtom | null>;

export interface PhoneHomeVariables {
  brokkr_live_token: string;
  phone_home_endpoint: string;
}

export class PhoneHomeService {
  readonly jobId: string;
  private readonly getServerTokenAtom: ServerTokenAtomFetcher;

  constructor(jobId: string, getServerTokenAtom: ServerTokenAtomFetcher) {
    this.jobId = jobId;
    this.getServerTokenAtom = getServerTokenAtom;
  }

  async getPhoneHomeVariables(deviceId: string): Promise<PhoneHomeVariables> {
    const token = await this.getServerTokenAtom({
      domain: 'server_token',
      entityId: String(deviceId),
      atomKey: deviceServerToken(deviceId),
      jobId: this.jobId,
    });
    if (token === null) {
      throw new PhoneHomeCredsUnavailable(
        `server_token atom unavailable for device ${deviceId} (hub render request timed out or returned negative-cache)`,
      );
    }

    void getLogger().info(`Phone home credentials configured for device ${deviceId}`, { jobId: this.jobId });
    return {
      brokkr_live_token: token.brokkr_live_token,
      phone_home_endpoint: token.endpoint,
    };
  }
}

export async function createPhoneHomeService(
  jobId: string,
  getServerTokenAtom: ServerTokenAtomFetcher,
): Promise<PhoneHomeService> {
  return new PhoneHomeService(jobId, getServerTokenAtom);
}
