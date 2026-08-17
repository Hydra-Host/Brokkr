import type { StartupLogger } from '../startup/startup-deps.types.js';
import type { ZoneCryptoBootstrapDeps } from '../startup/startup-services.js';
import {
  ZoneCryptoBootstrapService,
  type FetchLike,
  type ZoneCryptoBootstrapOptions,
  type ZoneCryptoCache,
  type ZoneCryptoCodec,
} from '../startup/zone-crypto-bootstrap.js';
import { getZoneCryptoConfig } from '../zone-crypto/zone-crypto.config.js';
import {
  setActiveZoneCryptoSnapshot,
  zoneCryptoFromCacheBlob,
  zoneCryptoToCacheBlob,
} from '../zone-crypto/zone-crypto.service.js';

const NO_OP_CACHE: ZoneCryptoCache = {
  secretGet: async () => null,
  secretSet: async () => false,
  acquireLock: async () => null,
  releaseLock: async () => false,
};

const PROCESS_WIDE_CODEC: ZoneCryptoCodec = {
  fromCacheBlob: zoneCryptoFromCacheBlob,
  toCacheBlob: zoneCryptoToCacheBlob,
  setActive: setActiveZoneCryptoSnapshot,
};

export interface ZoneCryptoBootstrapFactoryOptions {
  cacheFactory?: () => ZoneCryptoCache;
  cacheCloser?: () => Promise<void>;
  zoneId?: string;
  logger?: StartupLogger;
  fetchImpl?: FetchLike;
  markerWriter?: ZoneCryptoBootstrapOptions['markerWriter'];
  markerExists?: ZoneCryptoBootstrapOptions['markerExists'];
  exit?: ZoneCryptoBootstrapOptions['exit'];
  sleep?: ZoneCryptoBootstrapOptions['sleep'];
}

export function buildZoneCryptoBootstrapFactory(
  options: ZoneCryptoBootstrapFactoryOptions = {},
): ZoneCryptoBootstrapDeps {
  const {
    cacheFactory,
    cacheCloser,
    zoneId = (process.env.BROKKR_ZONE_ID ?? '').trim(),
    logger,
    fetchImpl,
    markerWriter,
    markerExists,
    exit,
    sleep,
  } = options;

  return {
    createBootstrap: (jobId: string) => {
      const cache: ZoneCryptoCache = cacheFactory !== undefined ? cacheFactory() : NO_OP_CACHE;
      const bootstrapOptions: ZoneCryptoBootstrapOptions = {
        cache,
        config: getZoneCryptoConfig(),
        zoneId,
        codec: PROCESS_WIDE_CODEC,
        logger,
        fetchImpl,
        markerWriter,
        markerExists,
        exit,
        sleep,
      };
      return new ZoneCryptoBootstrapService(jobId, bootstrapOptions);
    },
    closeCache: cacheCloser,
  };
}
