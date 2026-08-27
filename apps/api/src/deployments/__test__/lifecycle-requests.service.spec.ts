import { HttpException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminLifecycleRequestStatus, AdminLifecycleRequestType } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentsService } from '../services/deployments.service';
import { LifecycleRequestsService } from '../services/lifecycle-requests.service';
import { createMockDeploymentAggregate } from './fixtures';

const DEPLOYMENT_ID = 'deployment-123';
const REQUEST_ID = 'req-1';
const USER_ID = 'customer-admin';

function pendingRequest(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    deploymentId: DEPLOYMENT_ID,
    type: AdminLifecycleRequestType.REPROVISION,
    status: AdminLifecycleRequestStatus.PENDING,
    requestBody: {},
    requestedBy: { name: 'Hydra Admin' },
    approvedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    approvedById: null,
    ...over,
  };
}

describe('LifecycleRequestsService (customer)', () => {
  const mockPrisma = {
    adminLifecycleRequest: { update: vi.fn().mockResolvedValue({}) },
  };
  const mockContextService = {
    userId: USER_ID,
    requirePermission: vi.fn(),
  };
  const mockDeploymentsService = {
    getDeploymentAggregate: vi.fn(),
  };

  let service: LifecycleRequestsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPrisma.adminLifecycleRequest.update.mockResolvedValue({});
    mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(
      createMockDeploymentAggregate({ lifecycleRequests: [pendingRequest() as never] }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LifecycleRequestsService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: ContextService, useValue: mockContextService },
        { provide: DeploymentsService, useValue: mockDeploymentsService },
      ],
    }).compile();

    service = module.get(LifecycleRequestsService);
  });

  describe('approveLifecycleRequest', () => {
    it('marks a PENDING request APPROVED with the acting customer user', async () => {
      await expect(service.approveLifecycleRequest(DEPLOYMENT_ID, REQUEST_ID)).resolves.toEqual({ success: true });

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('lifecycle-request', 'approve');
      expect(mockPrisma.adminLifecycleRequest.update).toHaveBeenCalledWith({
        where: { id: REQUEST_ID },
        data: expect.objectContaining({
          status: AdminLifecycleRequestStatus.APPROVED,
          approvedById: USER_ID,
        }),
      });
      const data = mockPrisma.adminLifecycleRequest.update.mock.calls[0][0].data;
      expect(data.approvedAt).toBeInstanceOf(Date);
    });

    it('404s when the request is missing', async () => {
      mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(createMockDeploymentAggregate());

      await expect(service.approveLifecycleRequest(DEPLOYMENT_ID, REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });

    it('404s for a cross-tenant eviction request even if the ID matches', async () => {
      mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(
        createMockDeploymentAggregate({
          customerId: 'customer-123',
          lifecycleRequests: [
            pendingRequest({
              id: 'eviction',
              type: AdminLifecycleRequestType.DEPROVISION,
              requestBody: { organizationId: 'incoming-org-999' },
            }) as never,
          ],
        }),
      );

      await expect(service.approveLifecycleRequest(DEPLOYMENT_ID, 'eviction')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });

    it('rejects non-PENDING requests', async () => {
      mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(
        createMockDeploymentAggregate({
          lifecycleRequests: [pendingRequest({ status: AdminLifecycleRequestStatus.APPROVED }) as never],
        }),
      );

      await expect(service.approveLifecycleRequest(DEPLOYMENT_ID, REQUEST_ID)).rejects.toBeInstanceOf(HttpException);
      expect(mockPrisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('rejectLifecycleRequest', () => {
    it('marks a PENDING request REJECTED', async () => {
      await expect(service.rejectLifecycleRequest(DEPLOYMENT_ID, REQUEST_ID)).resolves.toEqual({ success: true });

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('lifecycle-request', 'approve');
      expect(mockPrisma.adminLifecycleRequest.update).toHaveBeenCalledWith({
        where: { id: REQUEST_ID },
        data: expect.objectContaining({
          status: AdminLifecycleRequestStatus.REJECTED,
        }),
      });
      const data = mockPrisma.adminLifecycleRequest.update.mock.calls[0][0].data;
      expect(data.rejectedAt).toBeInstanceOf(Date);
      expect(data).not.toHaveProperty('approvedById');
    });

    it('404s when the request is missing', async () => {
      mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(createMockDeploymentAggregate());

      await expect(service.rejectLifecycleRequest(DEPLOYMENT_ID, REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });

    it('404s for a cross-tenant eviction request even if the ID matches', async () => {
      mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(
        createMockDeploymentAggregate({
          customerId: 'customer-123',
          lifecycleRequests: [
            pendingRequest({
              id: 'eviction',
              type: AdminLifecycleRequestType.DEPROVISION,
              requestBody: { organizationId: 'incoming-org-999' },
            }) as never,
          ],
        }),
      );

      await expect(service.rejectLifecycleRequest(DEPLOYMENT_ID, 'eviction')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });

    it('rejects non-PENDING requests', async () => {
      mockDeploymentsService.getDeploymentAggregate.mockResolvedValue(
        createMockDeploymentAggregate({
          lifecycleRequests: [pendingRequest({ status: AdminLifecycleRequestStatus.EXECUTED }) as never],
        }),
      );

      await expect(service.rejectLifecycleRequest(DEPLOYMENT_ID, REQUEST_ID)).rejects.toBeInstanceOf(HttpException);
      expect(mockPrisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });
  });
});
