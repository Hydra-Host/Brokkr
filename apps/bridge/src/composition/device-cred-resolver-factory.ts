import type { ActiveDevicesCache } from '../monitoring/common/active-devices.service.js';
import {
  AtomBmcCredentialsLookup,
  StaticBmcCredentialsLookup,
  type BmcCredentialsLookup,
  type BmcSecretSource,
} from '../monitoring/common/bmc-credentials-lookup.service.js';
import { DeviceCredentialResolver } from '../monitoring/common/device-credential-resolver.service.js';

import { getBmcSecretSourceOrThrow } from './bmc-secret-source-holder.js';

export class BmcCredentialsCacheUnwiredError extends Error {
  constructor() {
    super(
      'BRIDGE_ORCHESTRATOR_ENABLED=true requires a BMC credentials cache factory; ' +
        'supply one to buildDeviceCredentialResolverFactory via the deviceCredentialResolver ' +
        'slot in composition/startup-args.ts. Without it, device_id-only IPMI/Redfish requests ' +
        'silently fail in production.',
    );
    this.name = 'BmcCredentialsCacheUnwiredError';
  }
}

function orchestratorEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.BRIDGE_ORCHESTRATOR_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export type DeviceCredentialResolverCache = ActiveDevicesCache;

export interface DeviceCredentialResolverFactoryOptions {
  cacheFactory?: () => DeviceCredentialResolverCache;
  secretSourceFactory?: () => BmcSecretSource;
  env?: NodeJS.ProcessEnv;
  jobId?: string;
}

export function buildDeviceCredentialResolverFactory(
  options: DeviceCredentialResolverFactoryOptions = {},
): () => DeviceCredentialResolver {
  const { cacheFactory, secretSourceFactory = getBmcSecretSourceOrThrow, env = process.env, jobId = '' } = options;

  if (cacheFactory === undefined && orchestratorEnabled(env)) {
    throw new BmcCredentialsCacheUnwiredError();
  }

  return (): DeviceCredentialResolver => {
    const primary: BmcCredentialsLookup =
      cacheFactory !== undefined
        ? new AtomBmcCredentialsLookup(secretSourceFactory, cacheFactory(), jobId)
        : new StaticBmcCredentialsLookup({});
    return new DeviceCredentialResolver(primary);
  };
}
