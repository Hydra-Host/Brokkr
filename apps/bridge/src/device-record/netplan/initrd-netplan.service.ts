import { Inject, Injectable, Optional } from '@nestjs/common';

import { NIL_DEVICE_ID } from '../../constants';
import { getLogger } from '../../logger/logger.service';

export const INITRD_NETPLAN_TIMEOUT_S = 30;

export interface GetLiveNetplanOptions {
  jobId?: string;
  timeoutS?: number;
}

export interface NetplanAtomLike {
  getLiveNetplan(deviceId: string, options?: GetLiveNetplanOptions): Promise<string | null>;
}

export interface InitrdNetplanLogger {
  warn(message: string, jobId?: string): void;
}

const FORWARDING_LOGGER: InitrdNetplanLogger = {
  warn: (msg, jobId) => void getLogger().warning(msg, { jobId }),
};

export const INITRD_NETPLAN_ATOM = Symbol('InitrdNetplanAtom');
export const INITRD_NETPLAN_LOGGER = Symbol('InitrdNetplanLogger');

export interface FetchLiveNetplanForInitrdOptions {
  jobId?: string;
}

@Injectable()
export class InitrdNetplanService {
  private readonly logger: InitrdNetplanLogger;

  constructor(
    @Inject(INITRD_NETPLAN_ATOM) private readonly netplanAtom: NetplanAtomLike,
    @Optional() @Inject(INITRD_NETPLAN_LOGGER) logger?: InitrdNetplanLogger,
  ) {
    this.logger = logger ?? FORWARDING_LOGGER;
  }

  async fetchLiveNetplanForInitrd(deviceId: string, options: FetchLiveNetplanForInitrdOptions = {}): Promise<string> {
    const { jobId = '' } = options;
    if (!deviceId || deviceId === NIL_DEVICE_ID) return '';
    try {
      const result = await this.netplanAtom.getLiveNetplan(deviceId, {
        jobId,
        timeoutS: INITRD_NETPLAN_TIMEOUT_S,
      });
      return result || '';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to fetch live netplan for device ${deviceId}: ${msg}`, jobId);
      return '';
    }
  }
}
