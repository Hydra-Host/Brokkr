import {
  DEFERRED_ABORT_CAUSE_OPERATOR_APPROVAL_REJECTED,
  PLUGIN_EVENT_BUS,
} from '@hydrahost/plugin-sdk';
import { BillingFrequency, JobType } from '@repo/database';
import { Test } from '@nestjs/testing';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { NotificationService } from 'src/notifications/notification.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvisionOutcomeNotificationObserver } from '../observers/provision-outcome-notification.observer';

type Handler = (event: unknown) => void | Promise<void>;
type FindAggregate = typeof DeploymentRecord.findAggregateUnscoped;

describe('ProvisionOutcomeNotificationObserver', () => {
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

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    handlers.clear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProvisionOutcomeNotificationObserver,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: NotificationService, useValue: notifications },
      ],
    }).compile();
    moduleRef.get(ProvisionOutcomeNotificationObserver).onModuleInit();
  });

  function mockDeployerAggregate() {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      nickname: 'gpu-box',
      customerId: 'org-1',
      deployer: { id: 'user-1' },
      server: { device: { name: 'host-1' } },
    } as Awaited<ReturnType<FindAggregate>>);
  }

  it('publishes provision.completed to the deployment deployer', async () => {
    mockDeployerAggregate();

    await handlers.get('provision.completed')!({
      jobId: 'job-1',
      jobType: JobType.Provision,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
    });

    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'provision.completed',
      idempotencyKey: 'provision-completed:job-1',
      userIds: ['user-1'],
      organizationId: 'org-1',
      title: 'Provisioning complete',
      body: 'Provisioning of host-1 completed successfully.',
      href: '/deployments/dep-1',
      channels: { inApp: true, email: true },
    });
  });

  it('publishes provision.failed to the deployment deployer with the error reason', async () => {
    mockDeployerAggregate();

    await handlers.get('provision.failed')!({
      jobId: 'job-2',
      jobType: JobType.Provision,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      error: 'bridge timed out',
    });

    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'provision.failed',
      idempotencyKey: 'provision-failed:job-2',
      userIds: ['user-1'],
      organizationId: 'org-1',
      title: 'Provisioning failed',
      body: 'Provisioning of host-1 failed: bridge timed out',
      href: '/deployments/dep-1',
      channels: { inApp: true, email: true },
    });
  });

  it('skips provision.failed publish when abort cause is operator approval rejected', async () => {
    mockDeployerAggregate();

    await handlers.get('provision.failed')!({
      jobId: 'job-reject',
      jobType: JobType.Provision,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      error: 'payment declined',
      cause: DEFERRED_ABORT_CAUSE_OPERATOR_APPROVAL_REJECTED,
    });

    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('publishes provision.started to the deployment deployer', async () => {
    mockDeployerAggregate();

    await handlers.get('provision.started')!({
      jobId: 'job-start',
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      internalProvision: false,
      manualBilling: false,
      billingFrequency: BillingFrequency.WEEKLY,
      reservationPrice: null,
      deviceName: 'host-1',
      deviceClass: 'H100',
      supplierOrganizationId: null,
    });

    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'provision.started',
      idempotencyKey: 'provision-started:job-start',
      userIds: ['user-1'],
      organizationId: 'org-1',
      title: 'Provisioning started',
      body: 'Provisioning of host-1 has started.',
      href: '/deployments/dep-1',
      channels: { inApp: true, email: true },
    });
  });

  it('does not subscribe or publish for deprovision outcomes', () => {
    expect(handlers.has('deprovision.completed')).toBe(false);
    expect(handlers.has('deprovision.failed')).toBe(false);
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('skips publish when deployment id is missing', async () => {
    const findAggregate = vi.spyOn(DeploymentRecord, 'findAggregateUnscoped');

    await handlers.get('provision.completed')!({
      jobId: 'job-3',
      jobType: JobType.Provision,
      deviceId: 'device-1',
      deploymentId: null,
      organizationId: 'org-1',
    });

    expect(findAggregate).not.toHaveBeenCalled();
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('skips publish when the deployment has no deployer', async () => {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);

    await handlers.get('provision.failed')!({
      jobId: 'job-4',
      jobType: JobType.Provision,
      deviceId: 'device-1',
      deploymentId: 'dep-missing',
      organizationId: 'org-1',
      error: 'boom',
    });

    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('calls publish again with the same idempotency key for a duplicate jobId', async () => {
    mockDeployerAggregate();

    const payload = {
      jobId: 'job-dup',
      jobType: JobType.Provision,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
    };

    await handlers.get('provision.completed')!(payload);
    await handlers.get('provision.completed')!(payload);

    expect(notifications.publish).toHaveBeenCalledTimes(2);
    expect(notifications.publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'provision-completed:job-dup' }),
    );
    expect(notifications.publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'provision-completed:job-dup' }),
    );
  });
});
