import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { Test } from '@nestjs/testing';
import { WebhookEventType } from '@repo/database';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DEPLOYMENTS_SERVICE } from 'src/deployments/deployments.tokens';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentWebhookObserver } from '../observers/deployment-webhook.observer';

type Handler = (event: unknown) => void | Promise<void>;
type FindAggregate = typeof DeploymentRecord.findAggregateUnscoped;

describe('DeploymentWebhookObserver', () => {
  const handlers = new Map<string, Handler>();
  const eventBus = {
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn((event: string, h: Handler) => {
      handlers.set(event, h);
      return () => {};
    }),
  };
  const deployments = { tryTriggerDeploymentEvent: vi.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    handlers.clear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DeploymentWebhookObserver,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: DEPLOYMENTS_SERVICE, useValue: deployments },
      ],
    }).compile();
    moduleRef.get(DeploymentWebhookObserver).onModuleInit();
  });

  it('triggers DEPLOYMENT_INTERRUPTED on scheduled', async () => {
    const aggregate = { id: 'dep-1' };
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
      aggregate as Awaited<ReturnType<FindAggregate>>,
    );

    await handlers.get('deployment.interruption.scheduled')!({
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      interruptAt: new Date(),
    });

    expect(deployments.tryTriggerDeploymentEvent).toHaveBeenCalledWith(
      WebhookEventType.DEPLOYMENT_INTERRUPTED,
      aggregate,
    );
  });

  it('triggers DEPLOYMENT_INTERRUPTION_COMPLETED on completed', async () => {
    const aggregate = { id: 'dep-1' };
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
      aggregate as Awaited<ReturnType<FindAggregate>>,
    );

    await handlers.get('deployment.interruption.completed')!({ deploymentId: 'dep-1', organizationId: 'org-1' });

    expect(deployments.tryTriggerDeploymentEvent).toHaveBeenCalledWith(
      WebhookEventType.DEPLOYMENT_INTERRUPTION_COMPLETED,
      aggregate,
    );
  });

  it('skips when no deployment is found', async () => {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
    await handlers.get('deployment.interruption.scheduled')!({
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      interruptAt: new Date(),
    });
    expect(deployments.tryTriggerDeploymentEvent).not.toHaveBeenCalled();
  });
});
