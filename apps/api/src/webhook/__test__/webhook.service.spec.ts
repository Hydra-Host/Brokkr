import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventType } from '@repo/database';
import { createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { Mock, vi } from 'vitest';
import { mockSupplyOrganization, mockWebhook, mockWebhookDelivery } from '../../prisma/fixtures';
import { WebhookDeliveryRepository } from '../webhook-delivery.repository';
import { WebhookDeliveryService } from '../webhook-delivery.service';
import { WebhookRepository } from '../webhook.repository';
import { WebhookService } from '../webhook.service';
import { CreateWebhookDTO, UpdateWebhookDTO, WebhookConfig } from '../webhook.types';

describe('WebhookService', () => {
  let service: WebhookService;
  let mockWebhookRepo: {
    create: Mock;
    update: Mock;
    findById: Mock;
    findFirst: Mock;
    findMany: Mock;
    reactivateWebhook: Mock;
    getWebhookStats: Mock;
  };
  let mockWebhookDeliveryRepo: {
    updateManyPendingOrRetryingToFailed: Mock;
  };
  let mockDeliveryService: Record<string, Mock>;

  beforeEach(async () => {
    mockWebhookRepo = {
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      reactivateWebhook: vi.fn(),
      getWebhookStats: vi.fn(),
    };
    mockWebhookDeliveryRepo = {
      updateManyPendingOrRetryingToFailed: vi.fn(),
    };
    mockDeliveryService = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: WebhookRepository,
          useValue: mockWebhookRepo,
        },
        {
          provide: WebhookDeliveryRepository,
          useValue: mockWebhookDeliveryRepo,
        },
        {
          provide: WebhookDeliveryService,
          useValue: mockDeliveryService,
        },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a webhook with generated secret', async () => {
      const createDto: CreateWebhookDTO = {
        endpoint: 'https://example.com/webhook',
        description: 'Test webhook',
        events: [WebhookEventType.DEVICE_LISTING_CREATED],
      };

      mockWebhookRepo.create.mockResolvedValue(mockWebhook);

      const result = await service.create(mockSupplyOrganization.id, createDto);

      expect(result).toEqual(mockWebhook);
      expect(mockWebhookRepo.create).toHaveBeenCalledWith(mockSupplyOrganization.id, {
        ...createDto,
        secret: expect.any(String),
      });
    });
  });

  describe('findOne', () => {
    it('should return a webhook when found', async () => {
      mockWebhookRepo.findFirst.mockResolvedValue(mockWebhook);

      const result = await service.findOne(mockWebhook.id);

      expect(result).toEqual(mockWebhook);
      expect(mockWebhookRepo.findFirst).toHaveBeenCalledWith({
        id: mockWebhook.id,
        deletedAt: null,
      });
    });

    it('should throw NotFoundException when webhook not found', async () => {
      mockWebhookRepo.findFirst.mockResolvedValue(null);

      await expect(service.findOne(mockWebhook.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update webhook without resetting failure count', async () => {
      const updateDto: UpdateWebhookDTO = {
        endpoint: 'https://new-example.com/webhook',
        isActive: true,
      };

      mockWebhookRepo.findFirst.mockResolvedValue(mockWebhook);
      mockWebhookRepo.update.mockResolvedValue(mockWebhook);

      const result = await service.update(mockWebhook.id, updateDto);

      expect(result).toEqual(mockWebhook);
      expect(mockWebhookRepo.update).toHaveBeenCalledWith(mockWebhook.id, updateDto);
    });

    it('should reset failure count when requested', async () => {
      const updateDto: UpdateWebhookDTO = {
        isActive: true,
      };

      mockWebhookRepo.findFirst.mockResolvedValue(mockWebhook);
      mockWebhookRepo.update.mockResolvedValue(mockWebhook);

      const result = await service.update(mockWebhook.id, updateDto, true);

      expect(result).toEqual(mockWebhook);
      expect(mockWebhookRepo.update).toHaveBeenCalledWith(mockWebhook.id, {
        ...updateDto,
        failureCount: 0,
        lastFailureAt: null,
      });
    });
  });

  describe('remove', () => {
    it('should soft delete a webhook', async () => {
      mockWebhookRepo.findFirst.mockResolvedValue(mockWebhook);
      mockWebhookRepo.update.mockResolvedValue({
        ...mockWebhook,
        deletedAt: new Date(),
      });

      await service.remove(mockWebhook.id);

      expect(mockWebhookRepo.update).toHaveBeenCalledWith(mockWebhook.id, {
        deletedAt: expect.any(Date),
      });
    });
  });

  describe('incrementFailureCount', () => {
    it('should increment failure count without disabling webhook', async () => {
      const webhookWithFailures = { ...mockWebhook, failureCount: 5 };
      mockWebhookRepo.update.mockResolvedValue(webhookWithFailures);

      await service.incrementFailureCount(mockWebhook.id);

      expect(mockWebhookRepo.update).toHaveBeenCalledTimes(1);
      expect(mockWebhookRepo.update).toHaveBeenCalledWith(mockWebhook.id, {
        failureCount: { increment: 1 },
        lastFailureAt: expect.any(Date),
      });
    });

    it('should disable webhook when reaching failure threshold', async () => {
      const webhookAtThreshold = {
        ...mockWebhook,
        failureCount: WebhookConfig.MAX_FAILURES_BEFORE_DISABLE,
      };
      mockWebhookRepo.update
        .mockResolvedValueOnce(webhookAtThreshold)
        .mockResolvedValueOnce({ ...webhookAtThreshold, isActive: false });

      await service.incrementFailureCount(mockWebhook.id);

      expect(mockWebhookRepo.update).toHaveBeenCalledTimes(2);
      expect(mockWebhookRepo.update).toHaveBeenNthCalledWith(2, mockWebhook.id, {
        isActive: false,
      });
      expect(mockWebhookDeliveryRepo.updateManyPendingOrRetryingToFailed).toHaveBeenCalledWith(
        mockWebhook.id,
        'Webhook was deactivated due to repeated failures',
      );
    });
  });

  describe('resetFailureCount', () => {
    it('should reset failure count and lastFailureAt', async () => {
      await service.resetFailureCount(mockWebhook.id);

      expect(mockWebhookRepo.update).toHaveBeenCalledWith(mockWebhook.id, {
        failureCount: 0,
        lastFailureAt: null,
      });
    });
  });

  describe('findAllByOrganization', () => {
    it('should return all webhooks for organization', async () => {
      const webhooks = [mockWebhook, { ...mockWebhook, id: 'webhook-456' }];
      mockWebhookRepo.findMany.mockResolvedValue(webhooks);

      const result = await service.findAllByOrganization(mockSupplyOrganization.id);

      expect(result).toEqual(webhooks);
      expect(mockWebhookRepo.findMany).toHaveBeenCalledWith({
        organizationId: mockSupplyOrganization.id,
        deletedAt: null,
      });
    });
  });

  describe('regenerateSecret', () => {
    it('should regenerate webhook secret', async () => {
      mockWebhookRepo.findFirst.mockResolvedValue(mockWebhook);
      mockWebhookRepo.update.mockResolvedValue({
        ...mockWebhook,
        secret: 'new-secret',
      });

      const result = await service.regenerateSecret(mockWebhook.id);

      expect(result).toHaveProperty('secret');
      expect(typeof result.secret).toBe('string');
      expect(mockWebhookRepo.update).toHaveBeenCalledWith(mockWebhook.id, {
        secret: expect.any(String),
      });
    });

    it('should throw NotFoundException when webhook not found', async () => {
      mockWebhookRepo.findFirst.mockResolvedValue(null);

      await expect(service.regenerateSecret(mockWebhook.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getWebhookStats', () => {
    it('should return webhook statistics', async () => {
      const mockStats = {
        total: 10,
        active: 8,
        failed: 2,
        recentDeliveries: [],
      };

      mockWebhookRepo.getWebhookStats.mockResolvedValue(mockStats);

      const result = await service.getWebhookStats(mockSupplyOrganization.id);

      expect(result).toEqual(mockStats);
      expect(mockWebhookRepo.getWebhookStats).toHaveBeenCalledWith(mockSupplyOrganization.id);
    });

    it('should return webhook statistics with recent deliveries', async () => {
      const mockDeliveryWithWebhook = {
        ...mockWebhookDelivery,
        webhook: {
          endpoint: mockWebhook.endpoint,
          description: mockWebhook.description,
        },
      };

      const mockStats = {
        total: 5,
        active: 3,
        failed: 1,
        recentDeliveries: [mockDeliveryWithWebhook],
      };

      mockWebhookRepo.getWebhookStats.mockResolvedValue(mockStats);

      const result = await service.getWebhookStats(mockSupplyOrganization.id);

      expect(result.total).toBe(5);
      expect(result.active).toBe(3);
      expect(result.failed).toBe(1);
      expect(result.recentDeliveries).toHaveLength(1);

      const [delivery] = result.recentDeliveries;
      expect(delivery).toMatchObject({
        id: mockWebhookDelivery.id,
        webhookId: mockWebhookDelivery.webhookId,
        eventType: mockWebhookDelivery.eventType,
        status: mockWebhookDelivery.status,
        httpStatus: mockWebhookDelivery.httpStatus,
        responseBody: mockWebhookDelivery.responseBody,
        errorMessage: mockWebhookDelivery.errorMessage,
        attempts: mockWebhookDelivery.attempts,
        nextRetryAt: mockWebhookDelivery.nextRetryAt,
        createdAt: mockWebhookDelivery.createdAt,
        deliveredAt: mockWebhookDelivery.deliveredAt,
        webhook: { endpoint: mockWebhook.endpoint, description: mockWebhook.description },
      });
      expect(delivery).not.toHaveProperty('idempotencyKey');
      expect(delivery).not.toHaveProperty('processingLockedBy');
      expect(delivery).not.toHaveProperty('processingLockedAt');
      expect(delivery).not.toHaveProperty('processingLockExpires');
      expect(delivery.webhook?.endpoint).toBe(mockWebhook.endpoint);
    });

    it('should handle empty organization with zero stats', async () => {
      const mockStats = {
        total: 0,
        active: 0,
        failed: 0,
        recentDeliveries: [],
      };

      mockWebhookRepo.getWebhookStats.mockResolvedValue(mockStats);

      const result = await service.getWebhookStats(mockSupplyOrganization.id);

      expect(result).toEqual(mockStats);
      expect(result.total).toBe(0);
      expect(result.active).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.recentDeliveries).toEqual([]);
    });
  });
});
