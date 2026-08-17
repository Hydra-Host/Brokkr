import { access } from 'node:fs/promises';

import type { CronStateSnapshot } from '../admin/cron-state.js';
import { getErrorMessage } from '../common/error-utils';
import type { DhcpRuntimeConfig } from '../dhcp/dhcp.config.js';
import type { DnsConfig } from '../dns/dns.config.js';
import { getDiscoveryFileConfig } from '../download/discovery.config.js';
import { getIpxeConfig } from '../ipxe/ipxe.config.js';
import {
  type DeviceCredentialResolver,
  configureDeviceCredentialResolver,
} from '../monitoring/common/device-credential-resolver.service.js';
import { isLocalSimulationEnabled } from '../redfish/redfish.config.js';
import { getStorageConfig } from '../sync/sync.config.js';

import { IPXE_VALID_ARCHES } from '../tftp/tftp-dyn-file.js';

import { assertChainReachability } from './chain-reachability-assert.js';
import { assertDiscoveryImages } from './discovery-image-assert.js';
import { assertIpxeBuilds } from './ipxe-build-assert.js';
import { resolveListenHost } from './listen-target.js';
import type { BackgroundService, StartupOrchestrator } from './orchestrator.js';
import type { AppConfig, StartupLogger, SyncConfig, TftpConfig } from './startup-deps.types.js';

export interface ZoneCryptoBootstrapLike {
  run(): Promise<unknown>;
}

export interface ZoneCryptoBootstrapDeps {
  createBootstrap(jobId: string): ZoneCryptoBootstrapLike;
  // the bootstrap cache is a process-lifetime Redis client; without releasing it the socket and
  // ioredis' reconnect timer keep the event loop referenced past shutdown.
  closeCache?(): Promise<void>;
}

export interface CronSupervisorLike {
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  states(): readonly CronStateSnapshot[];
}

export interface TftpServerLike {
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
}

export interface TftpServerDeps {
  config: TftpConfig;
  createManager(jobId: string): TftpServerLike;
}

export interface DnsServerDeps {
  config: DnsConfig;
  createService(): BackgroundService;
}

export interface DhcpServerDeps {
  config: DhcpRuntimeConfig;
  createService(): BackgroundService;
}

export interface DeviceCredentialResolverDeps {
  builder: () => DeviceCredentialResolver;
}

export interface SyncBlockingDeps {
  syncConfig: SyncConfig;
  validateHttpsConfig(cfg: SyncConfig): void;
  appConfig: AppConfig;
  syncDiscoveryImages?(jobId: string): Promise<void>;
}

export interface AgentUnitRenderStartupBlockingDeps {
  renderAgentUnitAtStartup(jobId: string): Promise<void>;
}

export function zoneCryptoBootstrap(deps: ZoneCryptoBootstrapDeps, logger: StartupLogger): BackgroundService {
  return {
    name: 'zone_crypto_bootstrap',
    start: async (jobId: string): Promise<void> => {
      try {
        const service = deps.createBootstrap(jobId);
        await service.run();
      } catch (exc) {
        logger.warn(`Zone crypto bootstrap task failed: ${getErrorMessage(exc)}`, { jobId });
      }
    },
    stop: async (jobId: string): Promise<void> => {
      try {
        await deps.closeCache?.();
      } catch (exc) {
        logger.warn(`Zone crypto bootstrap cache close failed: ${getErrorMessage(exc)}`, { jobId });
      }
    },
  };
}

export interface BuildStartupOrchestratorArgs {
  orchestrator: StartupOrchestrator;
  logger: StartupLogger;
  agentUnitRenderStartup: AgentUnitRenderStartupBlockingDeps;
  sync: SyncBlockingDeps;
  zoneCryptoBootstrap: ZoneCryptoBootstrapDeps;
  deviceCredentialResolver: DeviceCredentialResolverDeps;
  dnsServer: DnsServerDeps;
  dhcpServer: DhcpServerDeps;
}

export function registerStartupTasks(jobId: string, args: BuildStartupOrchestratorArgs): void {
  const { orchestrator, logger, sync } = args;

  orchestrator.addPreludeBlockingTask({
    name: 'render_agent_unit_at_startup',
    run: async (taskJobId: string): Promise<void> => {
      await args.agentUnitRenderStartup.renderAgentUnitAtStartup(taskJobId);
    },
  });

  orchestrator.addPreludeBlockingTask({
    name: 'configure_device_credential_resolver',
    run: async (): Promise<void> => {
      configureDeviceCredentialResolver(args.deviceCredentialResolver.builder);
    },
  });

  orchestrator.addPreludeBlockingTask({
    name: 'assert_chain_reachability',
    run: async (taskJobId: string): Promise<void> => {
      assertChainReachability(
        {
          bridgeUrl: getIpxeConfig().bridgeUrl,
          listenHost: resolveListenHost(),
          // DNS enablement and advertisement (option 6) are hub-atom-driven and unknowable at
          // startup; false keeps this boot-time check conservative rather than assuming either.
          dnsEnabled: false,
          dnsAdvertised: false,
          tlsTerminated: (process.env.BRIDGE_TLS_TERMINATED ?? '').trim().toLowerCase() === 'true',
          // DHCP mode is atom-derived at runtime (the PXE-04 no-lease-authority check lives in
          // the atom mapper); assume AUTHORITATIVE for this startup check.
          dhcpMode: 'AUTHORITATIVE',
        },
        logger,
        {
          strict: (process.env.BRIDGE_CHAIN_REACHABILITY_STRICT ?? '').trim().toLowerCase() === 'true',
          jobId: taskJobId,
        },
      );
    },
  });

  orchestrator.addPreludeBlockingTask({
    name: 'assert_ipxe_builds',
    run: async (taskJobId: string): Promise<void> => {
      await assertIpxeBuilds(
        {
          finalBuildsDir: getIpxeConfig().finalBuildsDir,
          architectures: [...IPXE_VALID_ARCHES],
        },
        async (path) =>
          access(path).then(
            () => true,
            () => false,
          ),
        logger,
        {
          strict: (process.env.BRIDGE_IPXE_BUILDS_STRICT ?? '').trim().toLowerCase() === 'true',
          jobId: taskJobId,
          localSimulation: isLocalSimulationEnabled(),
        },
      );
    },
  });

  orchestrator.addBlockingTask({
    name: 'validate_sync_config',
    run: async (taskJobId: string): Promise<void> => {
      sync.validateHttpsConfig(sync.syncConfig);
      logger.info(`HTTPS layer config validated (OS_LAYER_URL=${sync.syncConfig.osLayerUrl})`, { jobId: taskJobId });
    },
  });

  const runDiscoveryImageAssert = async (taskJobId: string): Promise<void> => {
    await assertDiscoveryImages(
      {
        discoveryDir: getStorageConfig().brokkrLiveHttpsDir,
        architectures: getDiscoveryFileConfig().architectures,
      },
      async (path) =>
        access(path).then(
          () => true,
          () => false,
        ),
      logger,
      {
        strict: (process.env.BRIDGE_DISCOVERY_IMAGES_STRICT ?? '').trim().toLowerCase() === 'true',
        jobId: taskJobId,
      },
    );
  };

  if (sync.appConfig.bridgeSyncEnabled) {
    const syncDiscoveryImages = sync.syncDiscoveryImages;
    if (syncDiscoveryImages !== undefined) {
      const bridgeSyncService: BackgroundService = {
        name: 'bridge_sync',
        start: async (taskJobId: string): Promise<void> => {
          try {
            logger.info('Initiating bridge sync background process', { jobId: taskJobId });
            await syncDiscoveryImages(taskJobId);
            logger.info('Bridge sync completed successfully', { jobId: taskJobId });
          } catch (exc) {
            logger.warn(`Bridge sync task failed: ${getErrorMessage(exc)}`, { jobId: taskJobId });
            return;
          }
          // Outside the sync catch so a BRIDGE_DISCOVERY_IMAGES_STRICT failure surfaces as a
          // bridge_sync task failure, not a sync error; strict=true cannot halt startup here.
          await runDiscoveryImageAssert(taskJobId);
        },
        stop: (): void => undefined,
      };
      orchestrator.addBackgroundService(bridgeSyncService);
    } else {
      logger.warn('Bridge sync enabled but syncDiscoveryImages dependency is missing; task skipped', { jobId });
    }
  } else {
    logger.info('Bridge sync disabled via BRIDGE_SYNC_ENABLED=false', { jobId });
  }

  if (!sync.appConfig.bridgeSyncEnabled || sync.syncDiscoveryImages === undefined) {
    orchestrator.addBlockingTask({
      name: 'assert_discovery_images',
      run: runDiscoveryImageAssert,
    });
  }

  orchestrator.addBackgroundService(zoneCryptoBootstrap(args.zoneCryptoBootstrap, logger));

  // Both always registered — no env-gated disabled path: until hub atoms arrive
  // (or while they say disabled) nothing binds and no packets are served.
  orchestrator.addBackgroundService(args.dnsServer.createService());
  orchestrator.addBackgroundService(args.dhcpServer.createService());
}
