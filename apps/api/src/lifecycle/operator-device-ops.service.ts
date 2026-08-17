import { Injectable, NotFoundException } from '@nestjs/common';
import { BenchmarkService } from 'src/brokkr-bridge/benchmarks/benchmarks.service';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { RescueModeService } from 'src/deployments/rescue-mode.service';
import { RESCUE_OS_SLUG } from 'src/provision/provision.types';

// Operator equivalents of `DeploymentsService`'s customer-facing discovery/benchmarks/rescue
// actions, keyed by deviceId and unscoped by tenant — the caller (operator-lifecycle plugin) gates on instance-operator identity.
@Injectable()
export class OperatorDeviceOpsService {
  constructor(
    private readonly bridgeInventoryCollectionService: BridgeInventoryCollectionService,
    private readonly benchmarkService: BenchmarkService,
    private readonly deviceContextService: DeviceContextService,
    private readonly rescueModeService: RescueModeService,
  ) {}

  async forceDiscovery(deviceId: string): Promise<{ jobId: string }> {
    const { zoneId } = await this.deviceContextService.resolveZoneContext(deviceId);
    return this.bridgeInventoryCollectionService.startInventoryCollection(deviceId, zoneId, 'manual');
  }

  async runBenchmarks(deviceId: string) {
    return this.benchmarkService.runBenchmarks(deviceId);
  }

  async activateRescueMode(deviceId: string, rescueOsSlug: string = RESCUE_OS_SLUG): Promise<void> {
    const aggregate = await this.requireActiveDeploymentAggregate(deviceId);
    const record = await DeploymentRecord.findOneUnscoped({ where: { id: aggregate.id, endDate: null } });
    if (!record) {
      throw new NotFoundException('Deployment not found');
    }
    await this.rescueModeService.activate({
      deviceId,
      aggregate,
      record,
      rescueOsSlug,
      opLabel: 'admin rescue activate',
    });
  }

  async deactivateRescueMode(deviceId: string): Promise<void> {
    const aggregate = await this.requireActiveDeploymentAggregate(deviceId);
    const record = await DeploymentRecord.findOneUnscoped({ where: { id: aggregate.id, endDate: null } });
    if (!record) {
      throw new NotFoundException('Deployment not found');
    }
    await this.rescueModeService.deactivate({
      deviceId,
      aggregate,
      record,
      opLabel: 'admin rescue deactivate',
    });
  }

  private async requireActiveDeploymentAggregate(deviceId: string) {
    const aggregate = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId } },
      orderBy: { createdAt: 'desc' },
    });
    if (!aggregate) {
      throw new NotFoundException('No active deployment for this device');
    }
    return aggregate;
  }
}
