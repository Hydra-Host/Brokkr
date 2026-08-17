import { Inject, Injectable, Optional } from '@nestjs/common';

import { getErrorMessage } from '../common/error-utils';
import { deviceSecret } from '../common/redis/redis-keys';
import {
  DEFAULT_TIMEOUT_S,
  FORWARDING_LOGGER,
  getAtom,
  type AtomCache,
  type AtomFetcherLogger,
  type EnqueueRenderRequest,
} from '../device-record/atom/atom-fetcher';
import { getActiveZoneCryptoSnapshot } from './zone-crypto.service';

import { forwardedSecretSchema, openBmcSecret, type OpenedBmcSecret } from './device-secret-open';

export { DEFAULT_TIMEOUT_S };

export const DEVICE_SECRET_ATOM_CACHE = Symbol('DeviceSecretAtomCache');
export const DEVICE_SECRET_ATOM_RENDER_ENQUEUER = Symbol('DeviceSecretAtomRenderEnqueuer');
export const DEVICE_SECRET_ATOM_BRIDGE_ID = Symbol('DeviceSecretAtomBridgeId');
export const DEVICE_SECRET_ATOM_LOGGER = Symbol('DeviceSecretAtomLogger');

export interface GetBmcSecretOptions {
  jobId?: string;
  timeoutS?: number;
}

@Injectable()
export class DeviceSecretAtomFetcher {
  constructor(
    @Inject(DEVICE_SECRET_ATOM_CACHE) private readonly cache: AtomCache,
    @Inject(DEVICE_SECRET_ATOM_RENDER_ENQUEUER)
    private readonly enqueueRenderRequest: EnqueueRenderRequest,
    @Inject(DEVICE_SECRET_ATOM_BRIDGE_ID) private readonly bridgeId: string,
    @Optional() @Inject(DEVICE_SECRET_ATOM_LOGGER) private readonly logger?: AtomFetcherLogger,
  ) {}

  async getBmcSecret(
    deviceId: string,
    purpose: string,
    kind: string,
    options: GetBmcSecretOptions = {},
  ): Promise<OpenedBmcSecret | null> {
    const { jobId = '', timeoutS = DEFAULT_TIMEOUT_S } = options;
    const logger = this.logger ?? FORWARDING_LOGGER;
    const atomKey = deviceSecret(deviceId, purpose, kind);
    const blob = await getAtom({
      cache: this.cache,
      enqueueRenderRequest: this.enqueueRenderRequest,
      bridgeId: this.bridgeId,
      domain: 'device_secret',
      entityId: deviceId,
      atomKey,
      valueSchema: forwardedSecretSchema,
      params: { purpose, kind },
      timeoutS,
      jobId,
      logger,
    });
    if (blob === null) return null;
    try {
      return openBmcSecret(blob);
    } catch (error) {
      // Degrade to null so one bad device never aborts a batch sweep; crypto-not-loaded means the SAME blob opens later (keep cached), otherwise it's stale/tampered (delete so the next lookup re-renders a fresh seal).
      const cryptoLoaded = getActiveZoneCryptoSnapshot() !== null;
      logger.warn(
        `device-secret atom for ${deviceId} (${purpose}/${kind}) present but unreadable` +
          `${cryptoLoaded ? ' — deleting to force re-render' : ' (zone crypto not loaded; keeping cached)'}: ` +
          getErrorMessage(error),
        jobId,
      );
      if (cryptoLoaded) {
        try {
          await this.cache.delete(atomKey, jobId);
        } catch (deleteError) {
          logger.warn(
            `device-secret atom for ${deviceId} (${purpose}/${kind}) re-render delete failed: ${getErrorMessage(deleteError)}`,
            jobId,
          );
        }
      }
      return null;
    }
  }
}
