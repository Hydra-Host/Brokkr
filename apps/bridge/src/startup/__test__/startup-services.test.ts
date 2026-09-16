import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChainReachabilityInput } from '../chain-reachability-assert.js';

vi.mock('../chain-reachability-assert.js', () => ({
  assertChainReachability: vi.fn(),
}));
vi.mock('../discovery-image-assert.js', () => ({
  assertDiscoveryImages: vi.fn(),
}));
vi.mock('../ipxe-build-assert.js', () => ({
  assertIpxeBuilds: vi.fn(),
}));

vi.mock('../../ipxe/ipxe.config.js', () => ({
  getIpxeConfig: () => ({ bridgeUrl: 'https://brokkr.lan', finalBuildsDir: '/tmp/ipxe' }),
}));
vi.mock('../listen-target.js', () => ({
  resolveListenHost: () => '0.0.0.0',
}));

import type { BootFinding } from '@repo/utils';
import {
  getBootReadinessFindings,
  resetBootReadinessFindingsForTests,
} from '../../composition/boot-readiness-holder.js';
import { assertChainReachability } from '../chain-reachability-assert.js';
import { assertDiscoveryImages } from '../discovery-image-assert.js';
import { assertIpxeBuilds } from '../ipxe-build-assert.js';
import { StartupOrchestrator } from '../orchestrator.js';
import type { StartupLogger } from '../startup-deps.types.js';
import type { BuildStartupOrchestratorArgs } from '../startup-services.js';
import { registerStartupTasks, zoneCryptoBootstrap } from '../startup-services.js';

function makeLogger(): StartupLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

function minimalArgs(overrides: Partial<BuildStartupOrchestratorArgs> = {}): BuildStartupOrchestratorArgs {
  const logger = makeLogger();
  const noopStart = vi.fn(async () => undefined);
  const noopStop = vi.fn(async () => undefined);
  return {
    orchestrator: new StartupOrchestrator(logger),
    logger,
    agentUnitRenderStartup: { renderAgentUnitAtStartup: vi.fn(async () => undefined) },
    sync: {
      syncConfig: { osLayerUrl: 'https://example/os' },
      validateHttpsConfig: vi.fn(),
      appConfig: {
        analyticsEnabled: true,
        bridgeSyncEnabled: false,
        environment: 'test',
        version: '0.0.0',
        host: '0.0.0.0',
        port: 5000,
        zoneId: 'zone-1',
      },
    },
    zoneCryptoBootstrap: { createBootstrap: () => ({ run: async () => undefined }) },
    deviceCredentialResolver: { builder: () => ({ get: async () => null }) as never },
    dnsServer: {
      config: { enabled: false } as never,
      createService: () => ({ name: 'dns_server', start: noopStart, stop: noopStop }),
    },
    dhcpServer: {
      config: { leaderPollMs: 2000, pruneIntervalMs: 60000, declineBackoffSeconds: 600 },
      createService: () => ({ name: 'dhcp_server', start: noopStart, stop: noopStop }),
    },
    ...overrides,
  };
}

describe('registerStartupTasks', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetBootReadinessFindingsForTests();
  });

  it('passes dnsEnabled=false and dnsAdvertised=false to chain reachability regardless of config (atom-driven at runtime)', async () => {
    const args = minimalArgs({
      dnsServer: {
        config: { enabled: true } as never,
        createService: () => ({
          name: 'dns_server',
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        }),
      },
    });

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');

    expect(assertChainReachability).toHaveBeenCalledTimes(1);
    const input = vi.mocked(assertChainReachability).mock.calls[0]![0] as ChainReachabilityInput;
    expect(input.dnsEnabled).toBe(false);
    expect(input.dnsAdvertised).toBe(false);
  });

  it('passes dnsAdvertised=false when DNS is disabled too', async () => {
    const args = minimalArgs({
      dnsServer: {
        config: { enabled: false } as never,
        createService: () => ({
          name: 'dns_server',
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        }),
      },
    });

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');

    expect(assertChainReachability).toHaveBeenCalledTimes(1);
    const input = vi.mocked(assertChainReachability).mock.calls[0]![0] as ChainReachabilityInput;
    expect(input.dnsEnabled).toBe(false);
    expect(input.dnsAdvertised).toBe(false);
  });

  it('does not block startup while bridge_sync is pending', async () => {
    let finishSync = (): void => undefined;
    const syncPending = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    let syncCompleted = false;
    const syncDiscoveryImages = vi.fn(async () => {
      await syncPending;
      syncCompleted = true;
    });
    const args = minimalArgs();
    args.sync.appConfig.bridgeSyncEnabled = true;
    args.sync.syncDiscoveryImages = syncDiscoveryImages;

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');

    expect(syncDiscoveryImages).not.toHaveBeenCalled();
    expect(assertDiscoveryImages).not.toHaveBeenCalled();

    await args.orchestrator.startBackgroundServices('job-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(syncDiscoveryImages).toHaveBeenCalledWith('job-1');
    expect(syncCompleted).toBe(false);
    expect(assertDiscoveryImages).not.toHaveBeenCalled();

    finishSync();
    await vi.waitFor(() => expect(assertDiscoveryImages).toHaveBeenCalledTimes(1));
    await args.orchestrator.stopAll('job-1');
  });

  it('logs a sync failure and skips the discovery-image assert', async () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const logger: StartupLogger = {
      info: (msg) => void lines.push({ level: 'info', msg }),
      warn: (msg) => void lines.push({ level: 'warn', msg }),
      error: (msg) => void lines.push({ level: 'error', msg }),
      debug: () => undefined,
    };
    const args = minimalArgs({ logger, orchestrator: new StartupOrchestrator(logger) });
    args.sync.appConfig.bridgeSyncEnabled = true;
    args.sync.syncDiscoveryImages = vi.fn(async () => {
      throw new Error('transport down');
    });

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');
    await args.orchestrator.startBackgroundServices('job-1');
    await vi.waitFor(() =>
      expect(lines.some((l) => l.level === 'warn' && l.msg === 'Bridge sync task failed: transport down')).toBe(true),
    );

    expect(assertDiscoveryImages).not.toHaveBeenCalled();
    expect(lines.some((l) => l.msg === "Background task 'bridge_sync' completed successfully")).toBe(true);
    await args.orchestrator.stopAll('job-1');
  });

  it('surfaces a strict discovery-image assert failure as a bridge_sync task failure, not a sync error', async () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const logger: StartupLogger = {
      info: (msg) => void lines.push({ level: 'info', msg }),
      warn: (msg) => void lines.push({ level: 'warn', msg }),
      error: (msg) => void lines.push({ level: 'error', msg }),
      debug: () => undefined,
    };
    const args = minimalArgs({ logger, orchestrator: new StartupOrchestrator(logger) });
    args.sync.appConfig.bridgeSyncEnabled = true;
    args.sync.syncDiscoveryImages = vi.fn(async () => undefined);
    vi.mocked(assertDiscoveryImages).mockRejectedValueOnce(
      new Error('Discovery image assertion failed for arch(es): x86_64; BRIDGE_DISCOVERY_IMAGES_STRICT=true.'),
    );

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');
    await args.orchestrator.startBackgroundServices('job-1');
    await vi.waitFor(() =>
      expect(
        lines.some(
          (l) =>
            l.level === 'warn' &&
            l.msg.startsWith("Background task 'bridge_sync' failed: Discovery image assertion failed"),
        ),
      ).toBe(true),
    );

    expect(lines.some((l) => l.msg === 'Bridge sync completed successfully')).toBe(true);
    expect(lines.some((l) => l.msg.startsWith('Bridge sync task failed'))).toBe(false);
    await args.orchestrator.stopAll('job-1');
  });

  it('records chain_reachability findings in the boot-readiness holder', async () => {
    const findings: BootFinding[] = [{ code: 'PXE-07', severity: 'warn', message: 'brokkr.lan unresolvable' }];
    vi.mocked(assertChainReachability).mockReturnValueOnce(findings);
    const args = minimalArgs();

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');

    expect(getBootReadinessFindings()).toEqual(findings);
  });

  it('records ipxe_builds findings in the boot-readiness holder', async () => {
    const findings: BootFinding[] = [
      { code: 'PXE-01', severity: 'error', message: 'amd64 builds missing' },
      { code: 'PXE-01', severity: 'error', message: 'arm64 builds missing' },
    ];
    vi.mocked(assertIpxeBuilds).mockResolvedValueOnce(findings);
    const args = minimalArgs();

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');

    expect(getBootReadinessFindings()).toEqual(findings);
  });

  it('records discovery_images findings in the boot-readiness holder when sync is disabled', async () => {
    const findings: BootFinding[] = [{ code: 'PXE-06', severity: 'error', message: 'amd64 discovery image missing' }];
    vi.mocked(assertDiscoveryImages).mockResolvedValueOnce(findings);
    const args = minimalArgs();

    registerStartupTasks('job-1', args);
    await args.orchestrator.runBlockingTasks('job-1');

    expect(getBootReadinessFindings()).toEqual(findings);
  });
});

describe('zoneCryptoBootstrap', () => {
  it('stop closes the injected bootstrap cache', async () => {
    const closeCache = vi.fn(async () => undefined);
    const service = zoneCryptoBootstrap(
      { createBootstrap: () => ({ run: async () => undefined }), closeCache },
      makeLogger(),
    );

    await service.stop('job-1');

    expect(closeCache).toHaveBeenCalledTimes(1);
  });

  it('stop stays fail-soft when the cache close throws', async () => {
    const warn = vi.fn();
    const logger: StartupLogger = { ...makeLogger(), warn };
    const service = zoneCryptoBootstrap(
      {
        createBootstrap: () => ({ run: async () => undefined }),
        closeCache: async () => {
          throw new Error('redis gone');
        },
      },
      logger,
    );

    await expect(service.stop('job-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stop is a no-op when no cache closer is wired', async () => {
    const service = zoneCryptoBootstrap({ createBootstrap: () => ({ run: async () => undefined }) }, makeLogger());

    await expect(service.stop('job-1')).resolves.toBeUndefined();
  });
});
