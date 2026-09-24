import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { Test } from '@nestjs/testing';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { NotificationService } from 'src/notifications/notification.service';
import { OrganizationMembershipsService } from 'src/organizations/members/organization-members.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InterruptionEmailObserver } from '../observers/interruption-email.observer';

type Handler = (event: unknown) => void | Promise<void>;
type FindAggregate = typeof DeploymentRecord.findAggregateUnscoped;

describe('InterruptionEmailObserver', () => {
  const handlers = new Map<string, Handler>();
  const eventBus = {
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn((event: string, h: Handler) => {
      handlers.set(event, h);
      return () => {};
    }),
  };
  const notifications = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const memberships = { getMembersForAnOrganization: vi.fn() };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    handlers.clear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InterruptionEmailObserver,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: NotificationService, useValue: notifications },
        { provide: OrganizationMembershipsService, useValue: memberships },
      ],
    }).compile();
    moduleRef.get(InterruptionEmailObserver).onModuleInit();
  });

  it('publishes a scheduled interruption notice to org members', async () => {
    memberships.getMembersForAnOrganization.mockResolvedValue([
      { user: { id: 'u-a', email: 'a@x.com' } },
      { user: { id: 'u-b', email: 'b@x.com' } },
    ]);
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      nickname: 'box',
    } as Awaited<ReturnType<FindAggregate>>);

    const interruptAt = new Date('2030-01-01T00:05:00.000Z');
    await handlers.get('deployment.interruption.scheduled')!({
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      interruptAt,
    });

    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'deployment.interruption.scheduled',
        idempotencyKey: `interruption-scheduled:dep-1:${interruptAt.toISOString()}`,
        userIds: ['u-a', 'u-b'],
        organizationId: 'org-1',
        href: '/deployments/dep-1',
        channels: { inApp: true, email: true },
      }),
    );
    expect(String(notifications.publish.mock.calls[0]?.[0]?.body ?? '')).toContain('box');
  });

  it('skips the scheduled notice when the org id is null', async () => {
    await handlers.get('deployment.interruption.scheduled')!({
      deploymentId: 'dep-1',
      organizationId: null,
      interruptAt: new Date(),
    });
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('publishes completion to the deployer', async () => {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      nickname: 'box',
      customerId: 'org-1',
      deployer: { id: 'deployer-1', email: 'dep@x.com' },
    } as Awaited<ReturnType<FindAggregate>>);

    await handlers.get('deployment.interruption.completed')!({ deploymentId: 'dep-1', organizationId: 'org-1' });

    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'deployment.interruption.completed',
      idempotencyKey: 'interruption-completed:dep-1',
      userIds: ['deployer-1'],
      organizationId: 'org-1',
      title: 'Deployment interruption complete',
      body: 'Your deployment has been interrupted. Deployment: box.',
      href: '/deployments/dep-1',
      channels: { inApp: true, email: true },
    });
  });

  it('publishes queued interruption to the incoming org members', async () => {
    memberships.getMembersForAnOrganization.mockResolvedValue([
      { user: { id: 'incoming-user', email: 'incoming@x.com' } },
    ]);

    await handlers.get('deployment.interruption.queued')!({
      incomingOrgId: 'incoming-org',
      deviceId: 'host-device',
      deploymentName: 'new-box',
      delayMs: 300_000,
    });

    expect(memberships.getMembersForAnOrganization).toHaveBeenCalledWith('incoming-org');
    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'deployment.interruption.queued',
        idempotencyKey: 'interruption-queued:incoming-org:host-device:300000',
        userIds: ['incoming-user'],
        organizationId: 'incoming-org',
        channels: { inApp: true, email: true },
      }),
    );
    expect(String(notifications.publish.mock.calls[0]?.[0]?.body ?? '')).toContain('new-box');
    expect(String(notifications.publish.mock.calls[0]?.[0]?.body ?? '')).toContain('host-device');
  });

  it('does not subscribe to provision.started', () => {
    expect(handlers.has('provision.started')).toBe(false);
  });
});
