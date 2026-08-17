import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultDnsConfig } from '../../dns/dns.config.js';
import {
  DeviceCredentialResolver,
  getDeviceCredentialResolver,
  resetDeviceCredentialResolverForTests,
  type BmcCredentialsLookup,
} from '../../monitoring/common/device-credential-resolver.service.js';
import type { RunStartupArgs } from '../run-startup.js';
import { runStartup } from '../run-startup.js';
import type { StartupLogger } from '../startup-deps.types.js';

const noopLookup: BmcCredentialsLookup = { get: async () => null };

const dnsConfig = (enabled: boolean) => ({ ...defaultDnsConfig({}), enabled, upstreamResolvers: ['1.1.1.1'] });

function makeLogger(): { logger: StartupLogger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger: StartupLogger = {
    info: (msg) => {
      lines.push({ level: 'info', msg });
    },
    warn: (msg) => {
      lines.push({ level: 'warn', msg });
    },
    error: (msg) => {
      lines.push({ level: 'error', msg });
    },
    debug: (msg) => {
      lines.push({ level: 'debug', msg });
    },
  };
  return { logger, lines };
}

function baseArgs(overrides: Partial<RunStartupArgs> = {}): RunStartupArgs {
  const { logger } = makeLogger();
  const noopStart = vi.fn(async () => undefined);
  const noopStop = vi.fn(async () => undefined);
  return {
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
    deviceCredentialResolver: {
      builder: () => new DeviceCredentialResolver(noopLookup),
    },
    dnsServer: {
      config: dnsConfig(false),
      createService: () => ({ name: 'dns_server', start: noopStart, stop: noopStop }),
    },
    dhcpServer: {
      config: {
        leaderPollMs: 2000,
        pruneIntervalMs: 60000,
        declineBackoffSeconds: 600,
      },
      createService: () => ({ name: 'dhcp_server', start: noopStart, stop: noopStop }),
    },
    ...overrides,
  };
}

describe('runStartup', () => {
  afterEach(() => resetDeviceCredentialResolverForTests());

  it('emits Phase 1 then Phase 2 announcement log lines in order', async () => {
    const { logger, lines } = makeLogger();
    const args = baseArgs({ logger });
    const orchestrator = await runStartup('job-1', args);

    const phaseLines = lines.filter((l) => l.msg.startsWith('Phase '));
    expect(phaseLines.map((l) => l.msg)).toEqual([
      'Phase 1: Running startup tasks',
      'Phase 2: Starting background tasks',
    ]);

    await orchestrator.stopAll('job-1');
  });

  it('runs the agent unit render prelude task before validate_sync_config', async () => {
    const { logger } = makeLogger();
    const order: string[] = [];
    const args = baseArgs({
      logger,
      agentUnitRenderStartup: {
        renderAgentUnitAtStartup: vi.fn(async () => {
          order.push('agent-unit');
        }),
      },
      sync: {
        syncConfig: { osLayerUrl: 'https://x' },
        validateHttpsConfig: vi.fn(() => order.push('validate')),
        appConfig: {
          analyticsEnabled: true,
          bridgeSyncEnabled: false,
          environment: 'test',
          version: '0.0.0',
          host: '0.0.0.0',
          port: 5000,
          zoneId: 'z',
        },
      },
    });

    const orchestrator = await runStartup('job-1', args);
    expect(order).toEqual(['agent-unit', 'validate']);
    await orchestrator.stopAll('job-1');
  });

  it('does not register bridge_sync when bridgeSyncEnabled is false', async () => {
    const { logger, lines } = makeLogger();
    const syncDiscoveryImages = vi.fn(async () => undefined);
    const args = baseArgs({ logger });
    args.sync.syncDiscoveryImages = syncDiscoveryImages;
    const orchestrator = await runStartup('job-1', args);

    expect(syncDiscoveryImages).not.toHaveBeenCalled();
    expect(lines.some((l) => l.msg === 'Running blocking task: bridge_sync')).toBe(false);
    expect(lines.some((l) => l.msg === 'Bridge sync disabled via BRIDGE_SYNC_ENABLED=false')).toBe(true);
    await orchestrator.stopAll('job-1');
  });

  it('returns before bridge_sync completes and starts it in the background', async () => {
    const { logger, lines } = makeLogger();
    let finishSync = (): void => undefined;
    const syncPending = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    let syncCompleted = false;
    const syncDiscoveryImages = vi.fn(async () => {
      await syncPending;
      syncCompleted = true;
    });
    const args = baseArgs({ logger });
    args.sync.appConfig.bridgeSyncEnabled = true;
    args.sync.syncDiscoveryImages = syncDiscoveryImages;

    const orchestrator = await runStartup('job-1', args);
    await new Promise((resolve) => setImmediate(resolve));

    expect(syncDiscoveryImages).toHaveBeenCalledWith('job-1');
    expect(syncCompleted).toBe(false);
    expect(lines.some((l) => l.msg === 'Initiating bridge sync background process')).toBe(true);
    expect(lines.some((l) => l.msg === 'Bridge sync completed successfully')).toBe(false);
    expect(lines.some((l) => l.msg === 'Phase 2: Starting background tasks')).toBe(true);

    finishSync();
    await vi.waitFor(() =>
      expect(lines.some((l) => l.msg === 'Bridge sync completed successfully')).toBe(true),
    );
    expect(syncCompleted).toBe(true);
    await orchestrator.stopAll('job-1');
  });

  it('keeps bridge_sync failures fail-soft', async () => {
    const { logger, lines } = makeLogger();
    const args = baseArgs({ logger });
    args.sync.appConfig.bridgeSyncEnabled = true;
    args.sync.syncDiscoveryImages = vi.fn(async () => {
      throw new Error('sync failed');
    });

    const orchestrator = await runStartup('job-1', args);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.some((l) => l.msg === 'Bridge sync task failed: sync failed')).toBe(true);
    await orchestrator.stopAll('job-1');
  });

  it('keeps HTTPS validation blocking when validation fails', async () => {
    const { logger, lines } = makeLogger();
    const args = baseArgs({
      logger,
      sync: {
        syncConfig: { osLayerUrl: 'https://x' },
        validateHttpsConfig: vi.fn(() => {
          throw new Error('bad https');
        }),
        appConfig: {
          analyticsEnabled: true,
          bridgeSyncEnabled: false,
          environment: 'test',
          version: '0.0.0',
          host: '0.0.0.0',
          port: 5000,
          zoneId: 'z',
        },
      },
    });

    await expect(runStartup('job-1', args)).rejects.toThrow('bad https');
    expect(lines.some((l) => l.msg === 'Phase 1: Running startup tasks')).toBe(true);
    expect(lines.some((l) => l.msg === 'Phase 2: Starting background tasks')).toBe(false);
  });

  it('registers the dns_server background service when DNS is enabled', async () => {
    const { logger, lines } = makeLogger();
    const createService = vi.fn(() => ({
      name: 'dns_server',
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }));
    const args = baseArgs({
      logger,
      dnsServer: {
        config: dnsConfig(true),
        createService,
      },
    });

    const orchestrator = await runStartup('job-1', args);
    expect(createService).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.msg === 'DNS server disabled via DNS_ENABLED')).toBe(false);
    await orchestrator.stopAll('job-1');
  });

  it('registers dns_server even when the baseline config is disabled (atoms enable it at runtime)', async () => {
    const { logger } = makeLogger();
    const createService = vi.fn(() => ({
      name: 'dns_server',
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }));
    const args = baseArgs({
      logger,
      dnsServer: {
        config: dnsConfig(false),
        createService,
      },
    });

    const orchestrator = await runStartup('job-1', args);
    expect(createService).toHaveBeenCalledTimes(1);
    await orchestrator.stopAll('job-1');
  });

  it('starts the dhcp_server daemon only in Phase 2, after Phase 1 blocking tasks complete (BB-12 ordering)', async () => {
    const { logger } = makeLogger();
    const order: string[] = [];
    const dhcpStart = vi.fn(async () => {
      order.push('dhcp-start');
    });
    const args = baseArgs({
      logger,
      agentUnitRenderStartup: {
        renderAgentUnitAtStartup: vi.fn(async () => {
          order.push('phase1-prelude');
        }),
      },
      dhcpServer: {
        config: baseArgs().dhcpServer.config,
        createService: () => ({ name: 'dhcp_server', start: dhcpStart, stop: vi.fn(async () => undefined) }),
      },
    });

    const orchestrator = await runStartup('job-1', args);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['phase1-prelude', 'dhcp-start']);
    await orchestrator.stopAll('job-1');
  });

  it('configures the DeviceCredentialResolver builder so monitoring controllers can resolve credentials after boot', async () => {
    const { logger } = makeLogger();
    const built = new DeviceCredentialResolver(noopLookup);
    const builder = vi.fn(() => built);
    const args = baseArgs({
      logger,
      deviceCredentialResolver: { builder },
    });

    const orchestrator = await runStartup('job-1', args);
    try {
      expect(() => getDeviceCredentialResolver()).not.toThrow();
      expect(getDeviceCredentialResolver()).toBe(built);
      expect(builder).toHaveBeenCalledTimes(1);
    } finally {
      await orchestrator.stopAll('job-1');
    }
  });
});
