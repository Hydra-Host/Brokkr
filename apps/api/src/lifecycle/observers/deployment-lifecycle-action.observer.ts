import { HOST_PLUGIN_ID, PLUGIN_EVENT_BUS, type BrokkrEventMap, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeploymentLifecycleActionType, JobType } from '@repo/database';
import { DeploymentRecord } from 'src/deployments/deployment.record';

const JOB_TYPE_TO_ACTION: Partial<Record<JobType, DeploymentLifecycleActionType>> = {
  [JobType.Provision]: DeploymentLifecycleActionType.Provision,
  [JobType.Reprovision]: DeploymentLifecycleActionType.Reprovision,
  [JobType.Reboot]: DeploymentLifecycleActionType.Reboot,
  [JobType.PowerOn]: DeploymentLifecycleActionType.PowerOn,
  [JobType.PowerOff]: DeploymentLifecycleActionType.PowerOff,
  [JobType.Deprovision]: DeploymentLifecycleActionType.Deprovision,
};

@Injectable()
export class DeploymentLifecycleActionObserver implements OnModuleInit, OnModuleDestroy {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(@Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.eventBus.on('lifecycle.dispatched', (e) => this.handleDispatched(e), { pluginId: HOST_PLUGIN_ID }),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async handleDispatched(event: BrokkrEventMap['lifecycle.dispatched']): Promise<void> {
    const actionType = JOB_TYPE_TO_ACTION[event.jobType];
    if (!actionType) return;

    const deploymentId = event.deploymentId ?? (await this.resolveActiveDeploymentId(event));
    if (!deploymentId) return;

    await DeploymentRecord.createLifecycleAction({
      deploymentId,
      actionType,
      source: event.source,
      performedBy: event.performedBy,
    });
  }

  private async resolveActiveDeploymentId(event: BrokkrEventMap['lifecycle.dispatched']): Promise<string | null> {
    if (!event.organizationId) return null;
    const aggregate = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId: event.deviceId }, customerId: event.organizationId },
    });
    return aggregate?.id ?? null;
  }
}
