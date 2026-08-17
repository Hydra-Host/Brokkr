import { HttpService } from '@nestjs/axios';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryStatus, WebhookEventType } from '@repo/database';
import { AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { Mock, vi } from 'vitest';
import {
  mockFailedWebhookDelivery,
  mockInactiveWebhook,
  mockPendingWebhookDelivery,
  mockRetryingWebhookDelivery,
  mockWebhook,
  mockWebhookDelivery,
} from '../../prisma/fixtures';
import { WebhookDeliveryRepository } from '../webhook-delivery.repository';
import { WebhookDeliveryService } from '../webhook-delivery.service';
import { WebhookRepository } from '../webhook.repository';
import { WebhookService } from '../webhook.service';
import { WebhookConfig, WebhookEventDTO, assertSafeDeliveryUrl } from '../webhook.types';

vi.mock('../webhook.types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook.types')>();
  return {
    ...actual,
    assertSafeDeliveryUrl: vi.fn(),
  };
});

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let mockHttpService: {
    post: Mock;
  };
  let mockWebhookService: {
    resetFailureCount: Mock;
    incrementFailureCount: Mock;
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
  };
  let mockWebhookRepo: {
    findById: Mock;
    reactivateWebhook: Mock;
  };

  const mockEvent: WebhookEventDTO = {
    eventType: WebhookEventType.DEVICE_LISTING_CREATED,
    data: { listingId: 'listing-123' },
    timestamp: new Date(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(assertSafeDeliveryUrl).mockResolvedValue({ address: '93.184.216.34', family: 4 });

    mockHttpService = {
      post: vi.fn(),
    };
    mockWebhookService = {
      resetFailureCount: vi.fn(),
      incrementFailureCount: vi.fn(),
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
    };
    mockWebhookRepo = {
      findById: vi.fn(),
      reactivateWebhook: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
        {
          provide: WebhookService,
          useValue: mockWebhookService,
        },
        {
          provide: WebhookDeliveryRepository,
          useValue: mockDeliveryRepo,
        },
        {
          provide: WebhookRepository,
          useValue: mockWebhookRepo,
        },
        {
          provide: ConfigService,
          useValue: { get: vi.fn() },
        },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    service = module.get<WebhookDeliveryService>(WebhookDeliveryService);
  });

  describe('scheduleDelivery', () => {
    it('should create a delivery and schedule immediate attempt', async () => {
      mockDeliveryRepo.create.mockResolvedValue(mockPendingWebhookDelivery);
      vi.spyOn(global, 'setImmediate');

      const result = await service.scheduleDelivery(mockWebhook, mockEvent);

      expect(result).toEqual(mockPendingWebhookDelivery);
      expect(mockDeliveryRepo.create).toHaveBeenCalledWith(mockWebhook.id, mockEvent.eventType, {
        eventType: mockEvent.eventType,
        data: mockEvent.data,
        timestamp: mockEvent.timestamp,
      });
      expect(setImmediate).toHaveBeenCalled();
    });
  });

  describe('attemptDelivery', () => {
    it('should successfully deliver webhook', async () => {
      const successResponse: AxiosResponse = {
        data: { success: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockDeliveryRepo.findById.mockResolvedValue({
        ...mockPendingWebhookDelivery,
        webhook: mockWebhook,
      });
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);
      mockDeliveryRepo.updateToSuccess.mockResolvedValue(successResponse);
      mockHttpService.post.mockReturnValue(of(successResponse));

      await service.attemptDelivery('delivery-123');

      expect(mockDeliveryRepo.incrementAttempts).toHaveBeenCalledWith('delivery-123');
      expect(mockHttpService.post).toHaveBeenCalledWith(
        mockWebhook.endpoint,
        mockPendingWebhookDelivery.payload,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Webhook-Signature': expect.any(String),
            'X-Webhook-Event': WebhookEventType.DEVICE_LISTING_CREATED,
            'X-Webhook-Delivery': mockPendingWebhookDelivery.id,
          }),
          timeout: WebhookConfig.TIMEOUT,
        }),
      );
      expect(mockDeliveryRepo.updateToSuccess).toHaveBeenCalledWith('delivery-123', successResponse);
      expect(mockWebhookService.resetFailureCount).toHaveBeenCalledWith(mockWebhook.id);
    });

    it('should handle HTTP error response', async () => {
      const errorResponse: AxiosResponse = {
        data: { error: 'Bad Request' },
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: {} as any,
      };

      mockDeliveryRepo.findById.mockResolvedValue({
        ...mockPendingWebhookDelivery,
        webhook: mockWebhook,
      });
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);
      mockHttpService.post.mockReturnValue(of(errorResponse));
      mockDeliveryRepo.update.mockResolvedValue(mockFailedWebhookDelivery);

      await service.attemptDelivery('delivery-123');

      expect(mockDeliveryRepo.update).toHaveBeenCalledWith(
        'delivery-123',
        expect.objectContaining({
          status: DeliveryStatus.RETRYING,
          errorMessage: expect.stringContaining('HTTP 400'),
          httpStatus: 400,
          nextRetryAt: expect.any(Date),
        }),
      );
    });

    it('should handle network error', async () => {
      const networkError = new Error('Network error');

      mockDeliveryRepo.findById.mockResolvedValue({
        ...mockPendingWebhookDelivery,
        webhook: mockWebhook,
      });
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);
      mockHttpService.post.mockReturnValue(throwError(() => networkError));
      mockDeliveryRepo.update.mockResolvedValue(mockFailedWebhookDelivery);

      await service.attemptDelivery('delivery-123');

      expect(mockDeliveryRepo.update).toHaveBeenCalledWith(
        'delivery-123',
        expect.objectContaining({
          status: DeliveryStatus.RETRYING,
          errorMessage: 'Network error',
        }),
      );
    });

    it('should capitalize timeout in error messages', async () => {
      const timeoutError = new Error('timeout of 10000ms exceeded');

      mockDeliveryRepo.findById.mockResolvedValue({
        ...mockPendingWebhookDelivery,
        webhook: mockWebhook,
      });
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);
      mockHttpService.post.mockReturnValue(throwError(() => timeoutError));
      mockDeliveryRepo.update.mockResolvedValue(mockFailedWebhookDelivery);

      await service.attemptDelivery('delivery-123');

      expect(mockDeliveryRepo.update).toHaveBeenCalledWith(
        'delivery-123',
        expect.objectContaining({
          status: DeliveryStatus.RETRYING,
          errorMessage: 'Timeout of 10000ms exceeded',
        }),
      );
    });

    it('should reject delivery when payload exceeds the size limit', async () => {
      const oversizedPayload = { blob: 'x'.repeat(WebhookConfig.MAX_PAYLOAD_BYTES + 1) };
      mockDeliveryRepo.findById.mockResolvedValue({
        ...mockPendingWebhookDelivery,
        payload: oversizedPayload,
        webhook: mockWebhook,
      });
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);

      await service.attemptDelivery('delivery-123');

      expect(mockHttpService.post).not.toHaveBeenCalled();
      expect(mockDeliveryRepo.updateToFailed).toHaveBeenCalledWith(
        'delivery-123',
        expect.stringContaining('exceeds limit'),
      );
    });

    it('should skip delivery for inactive webhook', async () => {
      mockDeliveryRepo.findById.mockResolvedValue({
        ...mockPendingWebhookDelivery,
        webhook: mockInactiveWebhook,
      });

      await service.attemptDelivery('delivery-123');

      expect(mockDeliveryRepo.updateToFailed).toHaveBeenCalledWith('delivery-123', 'Webhook is inactive');
      expect(mockHttpService.post).not.toHaveBeenCalled();
    });

    it('should mark as failed after max retries', async () => {
      const maxRetriesDelivery = {
        ...mockPendingWebhookDelivery,
        attempts: WebhookConfig.MAX_RETRIES,
        webhook: mockWebhook,
      };
      const networkError = new Error('Network error');

      mockDeliveryRepo.findById.mockResolvedValue(maxRetriesDelivery);
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);
      mockHttpService.post.mockReturnValue(throwError(() => networkError));
      mockDeliveryRepo.update.mockResolvedValue(mockFailedWebhookDelivery);

      await service.attemptDelivery('delivery-123');

      expect(mockDeliveryRepo.update).toHaveBeenCalledWith(
        'delivery-123',
        expect.objectContaining({
          status: DeliveryStatus.FAILED,
          errorMessage: 'Network error',
        }),
      );
      expect(mockWebhookService.incrementFailureCount).toHaveBeenCalledWith(mockWebhook.id);
    });

    it('should handle DEPLOYMENT_INTERRUPTED event correctly', async () => {
      const deploymentInterruptedDelivery = {
        id: 'delivery-deployment-interrupted',
        webhookId: 'webhook-456',
        eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
        payload: {
          eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
          data: {
            id: 'deployment-123',
            nickname: 'Production Server',
            isInterruptible: true,
            scheduledInterruptionTime: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        } as any,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        webhook: {
          ...mockWebhook,
          events: [WebhookEventType.DEPLOYMENT_INTERRUPTED],
        },
        idempotencyKey: 'idempotency-key-123',
        httpStatus: null,
        responseBody: null,
        errorMessage: null,
        lastError: null,
        nextRetryAt: null,
        lockToken: null,
        lockExpiresAt: null,
        deliveredAt: null,
        processingLockedBy: null,
        processingLockedAt: null,
        processingLockExpires: null,
      };

      const successResponse: AxiosResponse = {
        data: { success: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockDeliveryRepo.findById.mockResolvedValue(deploymentInterruptedDelivery);
      mockDeliveryRepo.incrementAttempts.mockResolvedValue(1);
      mockDeliveryRepo.updateToSuccess.mockResolvedValue(successResponse);
      mockHttpService.post.mockReturnValue(of(successResponse));

      await service.attemptDelivery('delivery-deployment-interrupted');

      expect(mockHttpService.post).toHaveBeenCalledWith(
        mockWebhook.endpoint,
        deploymentInterruptedDelivery.payload,
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Webhook-Event': WebhookEventType.DEPLOYMENT_INTERRUPTED,
            'X-Webhook-Delivery': 'delivery-deployment-interrupted',
          }),
        }),
      );

      const callArgs = mockHttpService.post.mock.calls[0];
      expect(callArgs[1]).toEqual({
        eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
        data: expect.objectContaining({
          id: 'deployment-123',
          nickname: 'Production Server',
          isInterruptible: true,
        }),
        timestamp: expect.any(String),
      });
    });
  });

  describe('retryDelivery', () => {
    it('should retry a failed delivery', async () => {
      const failedDelivery = {
        ...mockFailedWebhookDelivery,
        webhook: mockWebhook,
      };

      mockDeliveryRepo.findById.mockResolvedValue(failedDelivery);
      mockDeliveryRepo.resetForImmediateRetry.mockResolvedValue(mockWebhookDelivery);
      mockWebhookRepo.findById.mockResolvedValue(mockWebhook);
      vi.spyOn(global, 'setImmediate');

      const result = await service.retryDelivery('delivery-123');

      expect(result).toEqual(mockWebhookDelivery);
      expect(mockDeliveryRepo.resetForImmediateRetry).toHaveBeenCalledWith('delivery-123');
      expect(setImmediate).toHaveBeenCalled();
    });

    it('should reactivate inactive webhook on retry', async () => {
      const failedDelivery = {
        ...mockFailedWebhookDelivery,
        webhook: mockInactiveWebhook,
      };

      mockDeliveryRepo.findById.mockResolvedValue(failedDelivery);
      mockWebhookRepo.reactivateWebhook.mockResolvedValue({
        ...mockInactiveWebhook,
        isActive: true,
        failureCount: 0,
        lastFailureAt: null,
      });
      mockDeliveryRepo.resetForImmediateRetry.mockResolvedValue(mockWebhookDelivery);
      mockWebhookRepo.findById.mockResolvedValue({
        ...mockInactiveWebhook,
        isActive: true,
      });

      await service.retryDelivery('delivery-123');

      expect(mockWebhookRepo.reactivateWebhook).toHaveBeenCalledWith(mockInactiveWebhook.id);
    });

    it('should throw NotFoundException for non-existent delivery', async () => {
      mockDeliveryRepo.findById.mockResolvedValue(null);

      await expect(service.retryDelivery('delivery-123')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for pending delivery', async () => {
      const pendingDelivery = {
        ...mockPendingWebhookDelivery,
        webhook: mockWebhook,
      };

      mockDeliveryRepo.findById.mockResolvedValue(pendingDelivery);

      await expect(service.retryDelivery('delivery-123')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for retrying delivery', async () => {
      const retryingDelivery = {
        ...mockRetryingWebhookDelivery,
        webhook: mockWebhook,
      };

      mockDeliveryRepo.findById.mockResolvedValue(retryingDelivery);

      await expect(service.retryDelivery('delivery-123')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getDeliveryDetails', () => {
    it('should return delivery details', async () => {
      const deliveryWithWebhook = {
        ...mockWebhookDelivery,
        webhook: {
          endpoint: mockWebhook.endpoint,
          description: mockWebhook.description,
        },
      };

      mockDeliveryRepo.getDeliveryDetails.mockResolvedValue(deliveryWithWebhook);

      const result = await service.getDeliveryDetails('delivery-123');

      expect(result).toEqual(deliveryWithWebhook);
      expect(mockDeliveryRepo.getDeliveryDetails).toHaveBeenCalledWith('delivery-123');
    });

    it('should throw NotFoundException when delivery not found', async () => {
      mockDeliveryRepo.getDeliveryDetails.mockResolvedValue(null);

      await expect(service.getDeliveryDetails('delivery-123')).rejects.toThrow(NotFoundException);
    });
  });

  describe('cleanupOldDeliveries', () => {
    it('should clean up old deliveries and release expired locks', async () => {
      mockDeliveryRepo.cleanupOldDeliveries.mockResolvedValue({ count: 100 });
      mockDeliveryRepo.releaseExpiredLocks.mockResolvedValue({ count: 5 });

      const result = await service.cleanupOldDeliveries(30);

      expect(result).toBe(100);
      expect(mockDeliveryRepo.cleanupOldDeliveries).toHaveBeenCalledWith(30);
      expect(mockDeliveryRepo.releaseExpiredLocks).toHaveBeenCalled();
    });
  });

  describe('getDeliveries', () => {
    it('should return deliveries for organization', async () => {
      const deliveriesWithWebhook = [
        {
          ...mockWebhookDelivery,
          webhook: {
            endpoint: mockWebhook.endpoint,
            description: mockWebhook.description,
          },
        },
      ];
      mockDeliveryRepo.findManyForOrganization.mockResolvedValue(deliveriesWithWebhook);

      const result = await service.getDeliveries('org-123');

      expect(result).toEqual(deliveriesWithWebhook);
      expect(mockDeliveryRepo.findManyForOrganization).toHaveBeenCalledWith('org-123');
    });
  });
});
