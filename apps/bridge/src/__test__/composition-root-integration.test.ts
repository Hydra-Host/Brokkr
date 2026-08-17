import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withEnv } from './env-guard.js';

withEnv('BROKKR_ZONE_ID', '11111111-2222-3333-4444-555555555555');

import { AppModule } from '../app.module.js';
import { ATOM_FETCHER, type AtomFetcher } from '../bridge-network/netplan-atom.service.js';
import { HealthController } from '../bridge-status/health.controller.js';

const stubAtomFetcher: AtomFetcher = {
  getAtom: async () => null,
};

function census(kinds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return counts;
}

@Global()
@Module({
  providers: [{ provide: ATOM_FETCHER, useValue: stubAtomFetcher }],
  exports: [ATOM_FETCHER],
})
class AtomFetcherTestModule {}

function withOrchestratorEnabled(): { restore: () => void } {
  const previousOrchestrator = process.env.BRIDGE_ORCHESTRATOR_ENABLED;
  process.env.BRIDGE_ORCHESTRATOR_ENABLED = 'true';
  return {
    restore: () => {
      if (previousOrchestrator === undefined) {
        delete process.env.BRIDGE_ORCHESTRATOR_ENABLED;
      } else {
        process.env.BRIDGE_ORCHESTRATOR_ENABLED = previousOrchestrator;
      }
    },
  };
}

describe('AppModule production composition', () => {
  let moduleRef: TestingModule | null = null;
  let envGuard: { restore: () => void } | null = null;

  beforeEach(() => {
    envGuard = withOrchestratorEnabled();
  });

  afterEach(async () => {
    if (moduleRef !== null) {
      await moduleRef.close();
      moduleRef = null;
    }
    envGuard?.restore();
    envGuard = null;
  });

  it('boots AppModule with BRIDGE_ORCHESTRATOR_ENABLED=true and no constructor throws', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AtomFetcherTestModule, await AppModule.withPluginBackends()],
    }).compile();
    expect(moduleRef).toBeDefined();
  });

  it('resolves HealthController via DI and serves the /api/health body', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AtomFetcherTestModule, await AppModule.withPluginBackends()],
    }).compile();
    const controller = moduleRef.get(HealthController, { strict: false });
    const body = await controller.healthCheck();
    expect(['OK', 'degraded']).toContain(body.status);
    expect(body).toHaveProperty('bridge_version');
    expect(body).toHaveProperty('snmp_engine');
  });

  it.todo("BullmqRegistryService.getHandler('saga.run') returns a real handler");
  it.todo('GrpcServerService is constructible from the DI context');
  it.todo('LeaderElectionModule reachable (signature provider resolvable)');
  it.todo('BullmqModule reachable (BullmqRegistryService resolvable)');
  it.todo('IpxeModule reachable (signature provider resolvable)');
  it.todo('InitrdModule reachable (ATOM_FETCHER resolves from InitrdModule)');
  it.todo('DeviceRecordModule reachable (signature provider resolvable)');
  it.todo('NetplanModule reachable (signature provider resolvable)');
  it.todo('AutoCollectionModule reachable (AutoCollectionService resolvable)');
  it.todo('GatewayModule reachable (GrpcServerService resolvable)');
  it.todo('DispatchModule reachable (signature provider resolvable)');
  it.todo('ResultPublisherModule reachable (signature provider resolvable)');
  it.todo('TelegrafModule reachable (signature provider resolvable)');
  it.todo('TopologyBroadcasterModule reachable (signature provider resolvable)');

  it.runIf(process.env.BRIDGE_HANDLE_LEAK_TEST === '1')(
    'init + close leaves no new TCP or UDP handle referenced',
    async () => {
      const before = census(process.getActiveResourcesInfo());

      const started = await Test.createTestingModule({
        imports: [AtomFetcherTestModule, await AppModule.withPluginBackends()],
      }).compile();
      await started.init();
      await started.close();
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const after = census(process.getActiveResourcesInfo());
      for (const kind of ['TCPSocketWrap', 'TCPServerWrap', 'UDPWrap']) {
        expect({ kind, count: after.get(kind) ?? 0 }).toEqual({ kind, count: before.get(kind) ?? 0 });
      }
    },
    60_000,
  );
});

describe('AppModule + startProductionServer gate', () => {
  let envGuard: { restore: () => void } | null = null;

  beforeAll(() => {
    envGuard = withOrchestratorEnabled();
  });

  afterAll(() => {
    envGuard?.restore();
    envGuard = null;
  });

  it('orchestratorGateDecision reads BRIDGE_ORCHESTRATOR_ENABLED=true as enabled', async () => {
    const { orchestratorGateDecision } = await import('../main.js');
    expect(orchestratorGateDecision()).toBe('enabled');
  });

  it('buildStartupArgs composes against the live env without throwing at build time', async () => {
    const { buildStartupArgs } = await import('../composition/startup-args.js');
    const args = buildStartupArgs({});
    expect(args.logger).toBeDefined();
    expect(args.deviceCredentialResolver.builder).toBeDefined();
  });

  it('buildStartupArgs(BRIDGE_ORCHESTRATOR_ENABLED=true) composes; builder defers cache lookup to first invocation', async () => {
    const { buildStartupArgs } = await import('../composition/startup-args.js');
    const { resetBmcCacheForTests, setBmcCache, BmcCacheNotBoundError } = await import(
      '../composition/bmc-cache-holder.js'
    );

    resetBmcCacheForTests();
    const args = buildStartupArgs({ BRIDGE_ORCHESTRATOR_ENABLED: 'true' });
    expect(args.deviceCredentialResolver.builder).toBeDefined();

    expect(() => args.deviceCredentialResolver.builder()).toThrow(BmcCacheNotBoundError);

    setBmcCache({ scan: async () => [], get: async () => null });
    expect(() => args.deviceCredentialResolver.builder()).not.toThrow();
    resetBmcCacheForTests();
  });
});
