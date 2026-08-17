import {
  getCachedDeviceData,
  iterActiveDeviceIds,
  type ActiveDevicesCache,
} from '../monitoring/common/active-devices.service.js';
import {
  AtomBmcCredentialsLookup,
  StaticBmcCredentialsLookup,
  type BmcCredentialsLookup,
  type BmcSecretSource,
} from '../monitoring/common/bmc-credentials-lookup.service.js';
import { classifyRole, extractRole } from '../monitoring/common/infra-targets.js';
import {
  BridgePartitioner,
  installPartitioner as installPartitionerSingleton,
  type LeaderServiceProvider,
} from '../monitoring/common/partitioning.js';
import { buildMonitoringConfig } from '../monitoring/monitoring.config.js';
import { classifyPduVendor } from '../monitoring/telegraf/pdu-snmp-profiles.js';
import type { TelegrafConfigWriterConfig } from '../monitoring/telegraf/telegraf-config-writer.service.js';
import type {
  ActiveDevicesPort,
  BridgePartitionerPort,
  InfraTargetsPort,
  PduVendorClassifierPort,
} from '../monitoring/telegraf/telegraf-config-writer.types.js';
import type {
  TelegrafBmcCredentialsLookupLike,
  TelegrafPartitionerLike,
  TelegrafRuntimeConfig,
} from '../monitoring/telegraf/telegraf-runtime.service.js';
import { readTelegrafRuntimeConfigFromEnv } from '../monitoring/telegraf/telegraf-runtime.service.js';
import type { TelegrafModuleOptions } from '../monitoring/telegraf/telegraf.module.js';

import { getBmcSecretSourceOrThrow } from './bmc-secret-source-holder.js';

export interface TelegrafCache {
  secretHget(key: string, field: string, jobId?: string): Promise<string | null>;
  get(key: string, jobId?: string): Promise<string | null>;
  scan(pattern: string, jobId?: string): Promise<string[]>;
}

export interface TelegrafFactoryOptions {
  cacheProvider?: () => TelegrafCache;
  secretSourceProvider?: () => BmcSecretSource;
  leaderServiceProvider?: LeaderServiceProvider;
  jobId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TelegrafFactoryHandle {
  moduleOptions: TelegrafModuleOptions;
  orchestratorRuntime: { start(): Promise<void>; stop(): Promise<void> };
  telegrafEnabled: boolean;
}

class StartOncePartitioner implements BridgePartitionerPort, TelegrafPartitionerLike {
  private startPromise: Promise<void> | null = null;

  constructor(private readonly inner: BridgePartitioner) {}

  owns(deviceId: string): boolean {
    return this.inner.owns(deviceId);
  }

  async start(): Promise<void> {
    if (this.startPromise === null) {
      this.startPromise = this.inner.start();
    }
    await this.startPromise;
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }
}

class CachedActiveDevicesPort implements ActiveDevicesPort {
  constructor(private readonly cacheGetter: () => ActiveDevicesCache) {}

  iterActiveDeviceIds(jobId: string): AsyncIterable<string> {
    return iterActiveDeviceIds(this.cacheGetter(), jobId);
  }

  async getCachedDeviceData(deviceId: string, jobId: string): Promise<Record<string, unknown> | null> {
    return getCachedDeviceData(this.cacheGetter(), deviceId, jobId);
  }
}

class EmptyActiveDevicesPort implements ActiveDevicesPort {
  async *iterActiveDeviceIds(): AsyncGenerator<string, void, void> {}

  async getCachedDeviceData(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

const infraTargetsAdapter: InfraTargetsPort = {
  extractRole: (deviceData) => extractRole(deviceData),
  classifyRole: (role) => classifyRole(role),
};

const pduClassifierAdapter: PduVendorClassifierPort = {
  classifyPduVendor: (deviceData) => classifyPduVendor(deviceData),
};

export function getTelegrafConfig(env: NodeJS.ProcessEnv = process.env): {
  writerConfig: TelegrafConfigWriterConfig;
  runtimeConfig: TelegrafRuntimeConfig;
  outputPath: string;
} {
  const runtimeConfig = readTelegrafRuntimeConfigFromEnv(env);
  const writerConfig: TelegrafConfigWriterConfig = {
    outputPath: runtimeConfig.outputPath,
    renderConfig: {
      bridge_api_url: runtimeConfig.renderConfig.bridgeApiUrl,
      poll_interval: runtimeConfig.renderConfig.pollInterval,
      timeout: runtimeConfig.renderConfig.timeout,
    },
    debounceSeconds: runtimeConfig.debounceSeconds,
    pollIntervalSeconds: runtimeConfig.pollIntervalSeconds,
  };
  return { writerConfig, runtimeConfig, outputPath: runtimeConfig.outputPath };
}

function buildCredsLookup(
  cacheGetter: (() => TelegrafCache) | undefined,
  secretSourceGetter: () => BmcSecretSource,
  jobId: string,
): BmcCredentialsLookup & TelegrafBmcCredentialsLookupLike {
  if (cacheGetter === undefined) {
    return new StaticBmcCredentialsLookup({});
  }
  return new AtomBmcCredentialsLookup(secretSourceGetter, cacheGetter, jobId);
}

export function buildTelegrafFactory(options: TelegrafFactoryOptions = {}): TelegrafFactoryHandle {
  const env = options.env ?? process.env;
  const monitoringConfig = buildMonitoringConfig(env);
  const { writerConfig, runtimeConfig } = getTelegrafConfig(env);
  const jobId = options.jobId ?? '';

  const leaderServiceProvider: LeaderServiceProvider = options.leaderServiceProvider ?? ((): null => null);

  const innerPartitioner = new BridgePartitioner(leaderServiceProvider, jobId);
  const partitioner: BridgePartitionerPort & TelegrafPartitionerLike = new StartOncePartitioner(innerPartitioner);

  const credsLookup = buildCredsLookup(
    options.cacheProvider,
    options.secretSourceProvider ?? getBmcSecretSourceOrThrow,
    jobId,
  );

  const activeDevices: ActiveDevicesPort = options.cacheProvider
    ? new CachedActiveDevicesPort(options.cacheProvider)
    : new EmptyActiveDevicesPort();

  const moduleOptions: TelegrafModuleOptions = {
    partitioner,
    credsLookup,
    activeDevices,
    infraTargets: infraTargetsAdapter,
    pduClassifier: pduClassifierAdapter,
    writerConfig,
    runtimeConfig,
    jobId,
    installPartitioner: (p) => {
      if (p !== null) {
        installPartitionerSingleton(innerPartitioner);
      }
    },
  };

  const orchestratorRuntime = createOrchestratorBarrier();

  return {
    moduleOptions,
    orchestratorRuntime,
    telegrafEnabled: monitoringConfig.telegrafEnabled,
  };
}

function createOrchestratorBarrier(): { start(): Promise<void>; stop(): Promise<void> } {
  let resolveBarrier: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    resolveBarrier = resolve;
  });
  let stopped = false;

  return {
    start: async (): Promise<void> => {
      if (stopped) return;
      await barrier;
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      resolveBarrier?.();
    },
  };
}
