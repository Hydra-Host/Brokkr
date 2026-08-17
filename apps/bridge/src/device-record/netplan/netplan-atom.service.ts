import { Inject, Injectable, Optional } from '@nestjs/common';

import { netplanConfig } from '../../common/redis/redis-keys';
import {
  DEFAULT_TIMEOUT_S,
  getAtom,
  type AtomCache,
  type AtomFetcherLogger,
  type EnqueueRenderRequest,
} from '../atom/atom-fetcher';

import { netplanAtomSchema } from './netplan.schema';

export { DEFAULT_TIMEOUT_S };

export const NETPLAN_ATOM_CACHE = Symbol('NetplanAtomCache');
export const NETPLAN_ATOM_RENDER_ENQUEUER = Symbol('NetplanAtomRenderEnqueuer');
export const NETPLAN_ATOM_BRIDGE_ID = Symbol('NetplanAtomBridgeId');
export const NETPLAN_ATOM_LOGGER = Symbol('NetplanAtomLogger');

export interface GetLiveNetplanOptions {
  jobId?: string;
  timeoutS?: number;
}

@Injectable()
export class NetplanAtomService {
  constructor(
    @Inject(NETPLAN_ATOM_CACHE) private readonly cache: AtomCache,
    @Inject(NETPLAN_ATOM_RENDER_ENQUEUER)
    private readonly enqueueRenderRequest: EnqueueRenderRequest,
    @Inject(NETPLAN_ATOM_BRIDGE_ID) private readonly bridgeId: string,
    @Optional() @Inject(NETPLAN_ATOM_LOGGER) private readonly logger?: AtomFetcherLogger,
  ) {}

  async getLiveNetplan(deviceId: string, options: GetLiveNetplanOptions = {}): Promise<string | null> {
    const { jobId = '', timeoutS = DEFAULT_TIMEOUT_S } = options;
    const result = await getAtom({
      cache: this.cache,
      enqueueRenderRequest: this.enqueueRenderRequest,
      bridgeId: this.bridgeId,
      domain: 'netplan',
      entityId: deviceId,
      atomKey: netplanConfig(deviceId, 'live'),
      valueSchema: netplanAtomSchema,
      timeoutS,
      jobId,
      logger: this.logger,
    });
    return result !== null ? result.yaml : null;
  }
}
