import { HOST_PLUGIN_ID, PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebhookEventType } from '@repo/database';
import '@repo/lifecycle';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DEPLOYMENTS_SERVICE } from 'src/deployments/deployments.tokens';
import type { DeploymentsService } from 'src/deployments/services/deployments.service';

@Injectable()
export class DeploymentWebhookObserver implements OnModuleInit, OnModuleDestroy {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    @Inject(DEPLOYMENTS_SERVICE) private readonly deployments: DeploymentsService,
  ) {}

  onModuleInit(): void {
    const opts = { pluginId: HOST_PLUGIN_ID };
    this.unsubscribers.push(
      this.eventBus.on(
        'deployment.interruption.scheduled',
        (e) => this.trigger(e.deploymentId, WebhookEventType.DEPLOYMENT_INTERRUPTED),
        opts,
      ),
      this.eventBus.on(
        'deployment.interruption.completed',
        (e) => this.trigger(e.deploymentId, WebhookEventType.DEPLOYMENT_INTERRUPTION_COMPLETED),
        opts,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async trigger(deploymentId: string, eventType: WebhookEventType): Promise<void> {
    const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: deploymentId } });
    if (!aggregate) return;
    await this.deployments.tryTriggerDeploymentEvent(eventType, aggregate);
  }
}
