import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventType } from '@repo/database';
import { createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { Mock, vi } from 'vitest';
import { mockDeploymentInterruptedWebhook, mockMultiEventWebhook } from '../../prisma/fixtures';
import { WebhookDeliveryRepository } from '../webhook-delivery.repository';
import { WebhookDeliveryService } from '../webhook-delivery.service';
import { WebhookRepository } from '../webhook.repository';
import { WebhookService } from '../webhook.service';
import { CreateWebhookDTO } from '../webhook.types';

describe('Webhook - DEPLOYMENT_INTERRUPTED Event', () => {
  let webhookService: WebhookService;
  let deliveryService: WebhookDeliveryService;
  let mockWebhookRepo: {
    create: Mock;
    update: Mock;
    findFirst: Mock;
    findMany: Mock;
    findById: Mock;
    reactivateWebhook: Mock;
    getWebhookStats: Mock;
  };
  let mockDeliveryRepo: {
    create: Mock;
    findById: Mock;
    incrementAttempts: Mock;
    updateToSuccess: Mock;
    updateToFailed: Mock;
    update: Mock;
    resetForImmediateRetry: Mock;
    getDeliveryDetails: Mock;
    cleanupOldDeliveries: Mock;
    releaseExpiredLocks: Mock;
    findManyForOrganization: Mock;
    updateManyPendingOrRetryingToFailed: Mock;
  };
  let mockHttpService: {
    post: Mock;
  };

  const mockOrganizationId = mockDeploymentInterruptedWebhook.organizationId;

  const mockDeploymentData = {
    id: 'deployment-456',
    nickname: 'Production Server',
    device: {
      id: 'device-789',
      name: 'server-01',
      metadata: {
        id: 123,
      },
    },
    customer: {
      id: 'customer-abc',
      email: 'customer@example.com',
    },
    isInterruptible: true,
    scheduledInterruptionTime: new Date(Date.now() + 3600000),
  };

  beforeEach(async () => {
    mockWebhookRepo = {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findById: vi.fn(),
      reactivateWebhook: vi.fn(),
      getWebhookStats: vi.fn(),
    };

    mockDeliveryRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      incrementAttempts: vi.fn(),
      updateToSuccess: vi.fn(),
      updateToFailed: vi.fn(),
      update: vi.fn(),
      resetForImmediateRetry: vi.fn(),
      getDeliveryDetails: vi.fn(),
      cleanupOldDeliveries: vi.fn(),
      releaseExpiredLocks: vi.fn(),
      findManyForOrganization: vi.fn(),
      updateManyPendingOrRetryingToFailed: vi.fn(),
    };

    mockHttpService = {
      post: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        WebhookDeliveryService,
        {
          provide: WebhookRepository,
          useValue: mockWebhookRepo,
        },
        {
          provide: WebhookDeliveryRepository,
          useValue: mockDeliveryRepo,
        },
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
        {
          provide: ConfigService,
          useValue: { get: vi.fn() },
        },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    webhookService = module.get<WebhookService>(WebhookService);
    deliveryService = module.get<WebhookDeliveryService>(WebhookDeliveryService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Creating webhook with DEPLOYMENT_INTERRUPTED event', () => {
    it('should allow creating webhook with DEPLOYMENT_INTERRUPTED event', async () => {
      const createDto: CreateWebhookDTO = {
        endpoint: 'https://customer.com/deployment-webhooks',
        description: 'Deployment interruption notifications',
        events: [WebhookEventType.DEPLOYMENT_INTERRUPTED],
      };

      mockWebhookRepo.create.mockResolvedValue(mockDeploymentInterruptedWebhook);

      const result = await webhookService.create(mockOrganizationId, createDto);

      expect(result).toEqual(mockDeploymentInterruptedWebhook);
      expect(mockWebhookRepo.create).toHaveBeenCalledWith(
        mockOrganizationId,
        expect.objectContaining({
          events: [WebhookEventType.DEPLOYMENT_INTERRUPTED],
        }),
      );
    });

    it('should allow webhook with multiple events including DEPLOYMENT_INTERRUPTED', async () => {
      const createDto: CreateWebhookDTO = {
        endpoint: 'https://customer.com/all-webhooks',
        description: 'All event notifications',
        events: [
          WebhookEventType.DEVICE_LISTING_CREATED,
          WebhookEventType.DEPLOYMENT_INTERRUPTED,
          WebhookEventType.DEVICE_LISTING_UPDATED,
        ],
      };

      mockWebhookRepo.create.mockResolvedValue(mockMultiEventWebhook);

      const result = await webhookService.create(mockOrganizationId, createDto);

      expect(result.events).toContain(WebhookEventType.DEPLOYMENT_INTERRUPTED);
    });
  });

  describe('Webhook delivery for DEPLOYMENT_INTERRUPTED', () => {
    it('should create delivery with correct payload structure', async () => {
      const eventDto = {
        eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
        data: mockDeploymentData,
        timestamp: new Date(),
      };

      const mockDelivery = {
        id: 'delivery-123',
        webhookId: mockDeploymentInterruptedWebhook.id,
        eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
        payload: {
          eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
          data: mockDeploymentData,
          timestamp: eventDto.timestamp,
        },
        status: 'PENDING',
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDeliveryRepo.create.mockResolvedValue(mockDelivery as any);

      await deliveryService.scheduleDelivery(mockDeploymentInterruptedWebhook as any, eventDto);

      expect(mockDeliveryRepo.create).toHaveBeenCalledWith(
        mockDeploymentInterruptedWebhook.id,
        WebhookEventType.DEPLOYMENT_INTERRUPTED,
        expect.objectContaining({
          eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
          data: mockDeploymentData,
          timestamp: eventDto.timestamp,
        }),
      );
    });
  });

  describe('Filtering webhooks by organization', () => {
    it('should only return DEPLOYMENT_INTERRUPTED webhooks for specified organization', async () => {
      const orgWebhooks = [
        mockDeploymentInterruptedWebhook,
        {
          ...mockDeploymentInterruptedWebhook,
          id: 'webhook-2',
          events: [WebhookEventType.DEVICE_LISTING_CREATED],
        },
      ];

      mockWebhookRepo.findMany.mockResolvedValue(orgWebhooks as any);

      const result = orgWebhooks;

      expect(result).toHaveLength(2);
      expect(result[0].events).toContain(WebhookEventType.DEPLOYMENT_INTERRUPTED);
    });

    it('should not return webhooks from other organizations', async () => {
      mockWebhookRepo.findMany.mockResolvedValue([]);

      await mockWebhookRepo.findMany({
        organizationId: 'different-org-456',
        deletedAt: null,
      });

      expect(mockWebhookRepo.findMany).toHaveBeenCalledWith({
        organizationId: 'different-org-456',
        deletedAt: null,
      });
    });
  });

  describe('Update webhook to include DEPLOYMENT_INTERRUPTED', () => {
    it('should allow updating webhook to add DEPLOYMENT_INTERRUPTED event', async () => {
      const existingWebhook = {
        ...mockDeploymentInterruptedWebhook,
        events: [WebhookEventType.DEVICE_LISTING_CREATED],
      };

      const updateDto = {
        events: [WebhookEventType.DEVICE_LISTING_CREATED, WebhookEventType.DEPLOYMENT_INTERRUPTED],
      };

      mockWebhookRepo.findFirst.mockResolvedValue(existingWebhook as any);
      mockWebhookRepo.update.mockResolvedValue({
        ...existingWebhook,
        events: updateDto.events,
      } as any);

      const result = await webhookService.update(existingWebhook.id, updateDto);

      expect(result.events).toContain(WebhookEventType.DEPLOYMENT_INTERRUPTED);
      expect(mockWebhookRepo.update).toHaveBeenCalledWith(existingWebhook.id, updateDto);
    });
  });
});
