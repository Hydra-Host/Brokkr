import { HOST_PLUGIN_ID, PLUGIN_EVENT_BUS, type BrokkrEventMap, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import '@repo/lifecycle';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { EmailService } from 'src/email/email.service';
import { OrganizationMembershipsService } from 'src/organizations/members/organization-members.service';

@Injectable()
export class InterruptionEmailObserver implements OnModuleInit, OnModuleDestroy {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    private readonly email: EmailService,
    private readonly memberships: OrganizationMembershipsService,
  ) {}

  onModuleInit(): void {
    const opts = { pluginId: HOST_PLUGIN_ID };
    this.unsubscribers.push(
      this.eventBus.on('deployment.interruption.scheduled', (e) => this.handleScheduled(e), opts),
      this.eventBus.on('deployment.interruption.completed', (e) => this.handleCompleted(e), opts),
      this.eventBus.on('deployment.interruption.queued', (e) => this.handleQueued(e), opts),
      this.eventBus.on('provision.started', (e) => this.handleProvisionStarted(e), opts),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async handleScheduled(event: BrokkrEventMap['deployment.interruption.scheduled']): Promise<void> {
    if (!event.organizationId) return;

    const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: event.deploymentId } });
    if (!aggregate) return;

    const members = await this.memberships.getMembersForAnOrganization(event.organizationId);
    const emails = members.map((m) => m.user.email).filter(Boolean);
    if (emails.length === 0) return;

    await this.email.send.interruptionNotice({
      emails,
      deploymentName: aggregate.nickname,
      delayInMs: Math.max(0, event.interruptAt.getTime() - Date.now()),
    });
  }

  private async handleCompleted(event: BrokkrEventMap['deployment.interruption.completed']): Promise<void> {
    const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: event.deploymentId } });
    if (!aggregate) return;

    await this.email.send.interruptionComplete({
      email: aggregate.deployer.email,
      deploymentName: aggregate.nickname,
    });
  }

  private async handleQueued(event: BrokkrEventMap['deployment.interruption.queued']): Promise<void> {
    const members = await this.memberships.getMembersForAnOrganization(event.incomingOrgId);
    const emails = members.map((m) => m.user.email).filter(Boolean);
    for (const email of emails) {
      await this.email.send.interruptionQueued({
        email,
        deploymentName: event.deploymentName,
        deviceId: event.deviceId,
        delayInMs: event.delayMs,
      });
    }
  }

  private async handleProvisionStarted(event: BrokkrEventMap['provision.started']): Promise<void> {
    const aggregate = await DeploymentRecord.findAggregateUnscoped({ where: { id: event.deploymentId } });
    if (!aggregate) return;

    await this.email.send.provisioningStarted({
      email: aggregate.deployer.email,
      deploymentName: aggregate.nickname,
      deploymentId: event.deploymentId,
    });
  }
}
