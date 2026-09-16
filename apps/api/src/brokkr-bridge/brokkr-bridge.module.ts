import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DeviceSecretModule } from 'src/device-secret/device-secret.module';
import { DeviceTestRunsModule } from 'src/device-test-runs/device-test-runs.module';
import { DeviceTokensModule } from 'src/device-tokens/device-tokens.module';
import { DevicesModule } from 'src/devices/devices.module';
import { InventoryModule } from 'src/inventory/inventory.module';
import { LifecycleModule } from 'src/lifecycle/lifecycle.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SanitizationReportModule } from 'src/sanitization-reports/sanitization-report.module';
import { CommonModule } from '../common/common.module';
import { RedisModule } from '../common/redis';
import { SealedEnvelopeService } from '../crypto/sealed-envelope.service';
import { ZoneCryptoModule } from '../zone-crypto/zone-crypto.module';
import { BenchmarksRepository } from './benchmarks/benchmarks.repository';
import { BenchmarkService } from './benchmarks/benchmarks.service';
import { RESULTS_PREFIX, RESULTS_QUEUE_NAME } from './constants/queue.constants';
import { DeviceContextModule } from './device-context/device-context.module';
import { DeviceRecordModule } from './device-record/device-record.module';
import { DeviceRecordDeletedListener } from './device-record/listeners/device-record-deleted.listener';
import { COLLECTOR_HANDLERS } from './discovery/collectors';
import { CollectorRegistry } from './discovery/collectors/collector.registry';
import type { CollectorHandler } from './discovery/collectors/collector.types';
import { COMPOSERS } from './discovery/composers';
import { ComposerRegistry } from './discovery/composers/composer.registry';
import type { Composer } from './discovery/composers/composer.types';
import { DiscoveryEventsService } from './discovery/discovery-events.service';
import { DiscoveryIngressService } from './discovery/discovery-ingress.service';
import { DiscoveryOrchestratorService } from './discovery/discovery-orchestrator.service';
import { DiscoveryRunIssueRecorder } from './discovery/discovery-run-issue.recorder';
import { DiscoveryRunsController } from './discovery/discovery-runs.controller';
import { DiscoveryRunsService } from './discovery/discovery-runs.service';
import { DiscoveryS3UploadService } from './discovery/discovery-s3-upload.service';
import { DISCOVERY_LISTENERS } from './discovery/listeners';
import { JobLogWriterModule } from './job-logs/job-log-writer.module';
import { BridgeCommissioningService } from './lifecycle/commissioning.service';
import { BridgeDeprovisionService } from './lifecycle/deprovision.service';
import { BridgeEnrichmentService } from './lifecycle/enrichment.service';
import { BridgeInventoryCollectionService } from './lifecycle/inventory-collection.service';
import { LifecyclePreparationService } from './lifecycle/lifecycle-preparation.service';
import { BridgeNetworkScanService } from './lifecycle/network-scan.service';
import { OsLayersResolverService } from './lifecycle/os-layers-resolver.service';
import { BridgePowerControlService } from './lifecycle/power-control.service';
import { BridgeProvisionService } from './lifecycle/provision.service';
import { QualifyOrchestrationService } from './lifecycle/qualify-orchestration.service';
import { NetplanModule } from './netplan/netplan.module';
import { BridgeQueueService } from './queue/bridge-queue.service';
import { BridgeResultsConsumer } from './queue/bridge-results.consumer';
import { RenderRequestModule } from './render-request/render-request.module';
import { ServerTokenModule } from './server-token/server-token.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: RESULTS_QUEUE_NAME, prefix: RESULTS_PREFIX }),
    CommonModule,
    ConfigModule,
    DeviceContextModule,
    DeviceRecordModule,
    DeviceTokensModule,
    DeviceTestRunsModule,
    JobLogWriterModule,
    NetplanModule,
    RedisModule,
    RenderRequestModule,
    SanitizationReportModule,
    ServerTokenModule,
    PrismaModule,
    ZoneCryptoModule,
    forwardRef(() => DeviceSecretModule),
    forwardRef(() => DevicesModule),
    forwardRef(() => InventoryModule),
    forwardRef(() => LifecycleModule),
  ],
  controllers: [DiscoveryRunsController],
  providers: [
    BenchmarksRepository,
    BenchmarkService,
    BridgeDeprovisionService,
    BridgeEnrichmentService,
    BridgeInventoryCollectionService,
    BridgeNetworkScanService,
    BridgeCommissioningService,
    BridgePowerControlService,
    BridgeProvisionService,
    LifecyclePreparationService,
    OsLayersResolverService,
    QualifyOrchestrationService,
    BridgeQueueService,
    BridgeResultsConsumer,
    SealedEnvelopeService,
    DiscoveryIngressService,
    DiscoveryS3UploadService,
    ...COLLECTOR_HANDLERS,
    ...COMPOSERS,
    ...DISCOVERY_LISTENERS,
    DeviceRecordDeletedListener,
    DiscoveryEventsService,
    DiscoveryRunIssueRecorder,
    DiscoveryRunsService,
    DiscoveryOrchestratorService,
    {
      provide: CollectorRegistry,
      useFactory: (...handlers: CollectorHandler<unknown>[]) => {
        const registry = new CollectorRegistry();
        for (const handler of handlers) registry.register(handler);
        return registry;
      },
      inject: COLLECTOR_HANDLERS,
    },
    {
      provide: ComposerRegistry,
      useFactory: (...composers: Composer[]) => {
        const registry = new ComposerRegistry();
        for (const composer of composers) registry.register(composer);
        return registry;
      },
      inject: COMPOSERS,
    },
  ],
  exports: [
    BenchmarkService,
    BridgeDeprovisionService,
    BridgeEnrichmentService,
    BridgeInventoryCollectionService,
    BridgeNetworkScanService,
    BridgeCommissioningService,
    BridgePowerControlService,
    BridgeProvisionService,
    BridgeQueueService,
    DeviceContextModule,
    DeviceRecordModule,
    LifecyclePreparationService,
    QualifyOrchestrationService,
    ServerTokenModule,
  ],
})
export class BrokkrBridgeModule {}
