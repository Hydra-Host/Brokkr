import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import { RequestSource, WebhookEventType } from '@repo/database';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { SolLogService } from 'src/brokkr-bridge/sol-logs/sol-log.service';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { ContextService } from 'src/common/context/context.service';
import { createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { mockDeploymentInterruptedWebhook, mockSupplyOrganization, mockUser } from 'src/prisma/fixtures';
import { PrismaClient } from 'src/prisma/prisma.client';
import { CloudInitProcessor, ProvisionValidatorService } from 'src/provision/processors';
import { WebhookDeliveryService } from 'src/webhook/webhook-delivery.service';
import { WebhookRepository } from 'src/webhook/webhook.repository';
import { afterEach, beforeEach, describe, expect, it, type Mocked, vi } from 'vitest';
import { DeploymentPresenter } from '../deployment.presenter';
import { RescueModeService } from '../rescue-mode.service';
import { DeploymentsService } from '../services/deployments.service';
import { createMockDeploymentAggregate } from './fixtures';

describe('DeploymentsService - Webhook Methods', () => {
  let service: DeploymentsService;
  let mockWebhookRepo: Mocked<WebhookRepository>;
  let mockWebhookDeliveryService: Mocked<WebhookDeliveryService>;
  let mockContextService: ContextService;
  let loggerSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const mockDeploymentAggregate = createMockDeploymentAggregate({
    customerId: mockSupplyOrganization.id,
  });

  const mockWebhook1 = {
    ...mockDeploymentInterruptedWebhook,
    id: 'webhook-1',
    organizationId: mockSupplyOrganization.id,
  };
  const mockWebhook2 = {
    ...mockDeploymentInterruptedWebhook,
    id: 'webhook-2',
    organizationId: mockSupplyOrganization.id,
    endpoint: 'https://another.com/webhook',
  };

  beforeEach(async () => {
    ActiveRecordRegistry.configureForTest({ deployment: {}, deploymentLifecycleAction: {} });

    mockWebhookRepo = { findMany: vi.fn() } as unknown as Mocked<WebhookRepository>;
    mockWebhookDeliveryService = { scheduleDelivery: vi.fn() } as unknown as Mocked<WebhookDeliveryService>;

    mockContextService = {
      get organizationId() {
        return mockSupplyOrganization.id;
      },
      get userId() {
        return mockUser.id;
      },
      get requestSource() {
        return RequestSource.UI;
      },
    } as ContextService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeploymentsService,
        {
          provide: PrismaClient,
          useValue: {
            job: { findMany: vi.fn() },
            interruptibleClaim: { findMany: vi.fn() },
          },
        },
        { provide: WebhookRepository, useValue: mockWebhookRepo },
        { provide: WebhookDeliveryService, useValue: mockWebhookDeliveryService },
        { provide: LifecycleService, useValue: {} },
        { provide: SolLogService, useValue: {} },
        { provide: RescueModeService, useValue: {} },
        {
          provide: DeviceContextService,
          useValue: { resolveZoneContext: vi.fn().mockResolvedValue({ zoneId: 'zone-test' }) },
        },
        { provide: ContextService, useValue: mockContextService },
        { provide: CloudInitProcessor, useValue: { process: vi.fn() } },
        { provide: ProvisionValidatorService, useValue: {} },
        { provide: CloudInitTemplatesService, useValue: { resolveAndSave: vi.fn() } },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    service = module.get<DeploymentsService>(DeploymentsService);
    loggerSpy = vi.spyOn(service['logger'], 'log');
    errorSpy = vi.spyOn(service['logger'], 'error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerDeploymentEvent', () => {
    it('should trigger webhooks for the aggregate customerId', async () => {
      vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({ id: 'formatted' } as any);
      mockWebhookRepo.findMany.mockResolvedValue([mockWebhook1, mockWebhook2] as any);
      mockWebhookDeliveryService.scheduleDelivery.mockResolvedValue({} as any);

      await service.triggerDeploymentEvent(WebhookEventType.DEPLOYMENT_INTERRUPTED, mockDeploymentAggregate);

      expect(mockWebhookRepo.findMany).toHaveBeenCalledWith({
        isActive: true,
        events: { has: WebhookEventType.DEPLOYMENT_INTERRUPTED },
        organizationId: mockSupplyOrganization.id,
      });
      expect(mockWebhookDeliveryService.scheduleDelivery).toHaveBeenCalledTimes(2);
      expect(loggerSpy).toHaveBeenCalledWith(
        `Triggering DEPLOYMENT_INTERRUPTED event for 2 webhooks in organization ${mockSupplyOrganization.id}`,
      );
    });

    it('should not trigger webhooks when none match', async () => {
      vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({} as any);
      mockWebhookRepo.findMany.mockResolvedValue([]);

      await service.triggerDeploymentEvent(WebhookEventType.DEPLOYMENT_INTERRUPTED, mockDeploymentAggregate);
      expect(mockWebhookDeliveryService.scheduleDelivery).not.toHaveBeenCalled();
    });

    it('should handle delivery scheduling errors gracefully', async () => {
      vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({} as any);
      mockWebhookRepo.findMany.mockResolvedValue([mockWebhook1] as any);
      mockWebhookDeliveryService.scheduleDelivery.mockRejectedValueOnce(new Error('Delivery failed'));

      await service.triggerDeploymentEvent(WebhookEventType.DEPLOYMENT_INTERRUPTED, mockDeploymentAggregate);

      expect(errorSpy).toHaveBeenCalledWith(
        `Failed to schedule delivery for webhook ${mockWebhook1.id}:`,
        expect.any(Error),
      );
    });
  });

  describe('tryTriggerDeploymentEvent', () => {
    it('should call triggerDeploymentEvent and handle success', async () => {
      vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({} as any);
      mockWebhookRepo.findMany.mockResolvedValue([mockWebhook1] as any);
      mockWebhookDeliveryService.scheduleDelivery.mockResolvedValue({} as any);

      await service.tryTriggerDeploymentEvent(WebhookEventType.DEPLOYMENT_INTERRUPTED, mockDeploymentAggregate);
      expect(mockWebhookDeliveryService.scheduleDelivery).toHaveBeenCalled();
    });

    it('should catch and log errors without throwing', async () => {
      mockWebhookRepo.findMany.mockRejectedValue(new Error('Database error'));

      await expect(
        service.tryTriggerDeploymentEvent(WebhookEventType.DEPLOYMENT_INTERRUPTED, mockDeploymentAggregate),
      ).resolves.not.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to trigger webhook for device deployment update: Database error',
        expect.any(String),
      );
    });
  });
});
