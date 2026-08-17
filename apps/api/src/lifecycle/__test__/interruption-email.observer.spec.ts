import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { Test } from '@nestjs/testing';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { EmailService } from 'src/email/email.service';
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
  const email = {
    send: {
      interruptionNotice: vi.fn().mockResolvedValue(undefined),
      interruptionComplete: vi.fn().mockResolvedValue(undefined),
      interruptionQueued: vi.fn().mockResolvedValue(undefined),
      provisioningStarted: vi.fn().mockResolvedValue(undefined),
    },
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
        { provide: EmailService, useValue: email },
        { provide: OrganizationMembershipsService, useValue: memberships },
      ],
    }).compile();
    moduleRef.get(InterruptionEmailObserver).onModuleInit();
  });

  it('sends a notice email to all org members on scheduled', async () => {
    memberships.getMembersForAnOrganization.mockResolvedValue([
      { user: { email: 'a@x.com' } },
      { user: { email: 'b@x.com' } },
    ]);
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      nickname: 'box',
    } as Awaited<ReturnType<FindAggregate>>);

    await handlers.get('deployment.interruption.scheduled')!({
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      interruptAt: new Date(Date.now() + 300_000),
    });

    expect(email.send.interruptionNotice).toHaveBeenCalledWith(
      expect.objectContaining({ emails: ['a@x.com', 'b@x.com'], deploymentName: 'box' }),
    );
  });

  it('skips the notice when the org id is null', async () => {
    await handlers.get('deployment.interruption.scheduled')!({
      deploymentId: 'dep-1',
      organizationId: null,
      interruptAt: new Date(),
    });
    expect(email.send.interruptionNotice).not.toHaveBeenCalled();
  });

  it('sends a completion email to the deployer on completed', async () => {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      nickname: 'box',
      deployer: { email: 'dep@x.com' },
    } as Awaited<ReturnType<FindAggregate>>);

    await handlers.get('deployment.interruption.completed')!({ deploymentId: 'dep-1', organizationId: 'org-1' });

    expect(email.send.interruptionComplete).toHaveBeenCalledWith({ email: 'dep@x.com', deploymentName: 'box' });
  });

  it('sends a queued email to the incoming org members on interruption.queued', async () => {
    memberships.getMembersForAnOrganization.mockResolvedValue([{ user: { email: 'incoming@x.com' } }]);

    await handlers.get('deployment.interruption.queued')!({
      incomingOrgId: 'incoming-org',
      deviceId: 'host-device',
      deploymentName: 'new-box',
      delayMs: 300_000,
    });

    expect(memberships.getMembersForAnOrganization).toHaveBeenCalledWith('incoming-org');
    expect(email.send.interruptionQueued).toHaveBeenCalledWith({
      email: 'incoming@x.com',
      deploymentName: 'new-box',
      deviceId: 'host-device',
      delayInMs: 300_000,
    });
  });

  it('sends a provisioning-started email to the deployer on provision.started', async () => {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      nickname: 'new-box',
      deployer: { email: 'incoming@x.com' },
    } as Awaited<ReturnType<FindAggregate>>);

    await handlers.get('provision.started')!({
      jobId: 'incoming-1',
      deviceId: 'incoming-device',
      deploymentId: 'dep-1',
      organizationId: 'incoming-org',
    });

    expect(email.send.provisioningStarted).toHaveBeenCalledWith({
      email: 'incoming@x.com',
      deploymentName: 'new-box',
      deploymentId: 'dep-1',
    });
  });
});
