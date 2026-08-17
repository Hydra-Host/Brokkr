import { ConsoleLogger, Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service';
import { Dispatcher } from '../agent/dispatch/dispatcher.service';
import { BenchmarksModule } from '../benchmarks/benchmarks.module';
import { ATOM_FETCHER } from '../bridge-network/netplan-atom.service';
import { BrokkrLiveModule } from '../brokkr-live/brokkr-live.module';
import { BullmqQueueService } from '../bullmq/queue.service';
import { CollectionModule } from '../collection/collection.module';
import { RedisService } from '../common/redis/redis.service';
import { BULLMQ_RESULTS_SERVICE } from '../composition/composition-tokens';
import { DeprovisionModule } from '../deprovision/deprovision.module';
import { DeviceHealthCheckModule } from '../device-health-check/device-health-check.module';
import { NetplanAtomService } from '../device-record/netplan/netplan-atom.service';
import { EnrichViaPxeModule } from '../enrich-via-pxe/enrich-via-pxe.module';
import { EFI_BOOT_DISPATCH } from '../lifecycle-deploy/efi-boot.service';
import { LifecycleDeployModule } from '../lifecycle-deploy/lifecycle-deploy.module';
import { ContextLogger } from '../logger/logger.service';
import { NetworkScanModule } from '../network-scan/network-scan.module';
import { CommissionModule } from '../commission/commission.module';
import { OobModule } from '../oob/oob.module';
import { PowerOpsModule } from '../power-ops/power-ops.module';
import { ProvisionModule } from '../provision/provision.module';
import { SyncModule } from '../sync/sync.module';

@Global()
@Module({
  providers: [
    { provide: ContextLogger, useValue: { log: () => undefined, error: () => undefined, warn: () => undefined } },
    {
      provide: RedisService,
      useValue: {
        connection: {},
        get: async () => null,
        delete: async () => undefined,
      },
    },
    { provide: ConnectionRegistry, useValue: { snapshotSessionHandles: async () => [] } },
    { provide: Dispatcher, useValue: { dispatch: async () => undefined } },
    { provide: BullmqQueueService, useValue: { getResultsQueue: async () => null } },
    { provide: BULLMQ_RESULTS_SERVICE, useValue: { enqueueResult: async () => true } },
    { provide: EFI_BOOT_DISPATCH, useValue: { dispatch: async () => undefined } },
    { provide: ATOM_FETCHER, useValue: { getAtom: async () => null } },
    { provide: NetplanAtomService, useValue: { getLiveNetplan: async () => null } },
  ],
  exports: [
    ContextLogger,
    RedisService,
    ConnectionRegistry,
    Dispatcher,
    BullmqQueueService,
    BULLMQ_RESULTS_SERVICE,
    EFI_BOOT_DISPATCH,
    ATOM_FETCHER,
    NetplanAtomService,
  ],
})
class SagaTestEnvModule {}

const SILENT_LOGGER = new ConsoleLogger();
SILENT_LOGGER.setLogLevels([]);

type AnyModule = Parameters<typeof Test.createTestingModule>[0]['imports'] extends Array<infer T> ? T : never;

async function mount(module: unknown): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [SagaTestEnvModule, module as AnyModule],
  })
    .setLogger(SILENT_LOGGER)
    .compile();
  expect(moduleRef).toBeDefined();
  await moduleRef.close();
}

describe('saga workflow modules mount via AppModule-equivalent env', () => {
  it('OobModule', async () => {
    await mount(OobModule);
  });

  it('CollectionModule', async () => {
    await mount(CollectionModule);
  });

  it('BrokkrLiveModule', async () => {
    await mount(BrokkrLiveModule);
  });

  it('LifecycleDeployModule', async () => {
    await mount(LifecycleDeployModule);
  });

  it('BenchmarksModule', async () => {
    await mount(BenchmarksModule);
  });

  it('DeprovisionModule', async () => {
    await mount(DeprovisionModule);
  });

  it('DeviceHealthCheckModule', async () => {
    await mount(DeviceHealthCheckModule);
  });

  it('EnrichViaPxeModule', async () => {
    await mount(EnrichViaPxeModule);
  });

  it('NetworkScanModule', async () => {
    await mount(NetworkScanModule);
  });

  it('CommissionModule', async () => {
    await mount(CommissionModule);
  });

  it('PowerOpsModule', async () => {
    await mount(PowerOpsModule);
  });

  it('ProvisionModule', async () => {
    await mount(ProvisionModule);
  });

  it('SyncModule', async () => {
    await mount(SyncModule);
  });
});
