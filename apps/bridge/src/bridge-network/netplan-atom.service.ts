import { Inject, Injectable } from '@nestjs/common';

import { netplanConfig } from '../common/redis/redis-keys';
import type { NetplanAtom } from '../device-record/netplan/netplan.schema';
import { netplanAtomSchema } from '../device-record/netplan/netplan.schema';

export const DEFAULT_TIMEOUT_S = 300;

export interface GetLiveNetplanOptions {
  jobId?: string;
  timeoutS?: number;
}

export interface AtomFetcher {
  getAtom<T>(args: {
    domain: string;
    entityId: string;
    atomKey: string;
    valueSchema: { parse(input: unknown): T };
    timeoutS?: number;
    jobId?: string;
  }): Promise<T | null>;
}

export const ATOM_FETCHER = Symbol('ATOM_FETCHER');

@Injectable()
export class NetplanAtomService {
  constructor(@Inject(ATOM_FETCHER) private readonly atomFetcher: AtomFetcher) {}

  async getLiveNetplan(deviceId: string, options: GetLiveNetplanOptions = {}): Promise<string | null> {
    const { jobId = '', timeoutS = DEFAULT_TIMEOUT_S } = options;
    const result = await this.atomFetcher.getAtom<NetplanAtom>({
      domain: 'netplan',
      entityId: deviceId,
      atomKey: netplanConfig(deviceId, 'live'),
      valueSchema: netplanAtomSchema,
      timeoutS,
      jobId,
    });
    return result !== null ? result.yaml : null;
  }
}
