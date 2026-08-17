import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminLifecycleRequestStatus, RequestSource } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptibleApprovalsService } from '../interruptible-approvals.service';
import { LifecycleService } from '../lifecycle.service';

const provisionRequest = {
  deviceId: 'incoming-device',
  userId: 'incoming-user',
  organizationId: 'incoming-org',
  deploymentName: 'new-box',
  operatingSystemSlug: 'ubuntu-22',
  sshKeyIds: ['key-1'],
  diskLayouts: [],
  cloudInit: null,
  ipxeUrl: null,
  customizations: null,
  source: RequestSource.API,
};

function pendingRequest(over: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    deploymentId: 'outgoing-dep',
    deviceId: 'host-device',
    type: 'DEPROVISION',
    status: AdminLifecycleRequestStatus.PENDING,
    requestBody: provisionRequest,
    requestedById: 'incoming-user',
    createdAt: new Date('2026-06-14T00:00:00Z'),
    ...over,
  };
}

describe('InterruptibleApprovalsService', () => {
  const prisma = {
    adminLifecycleRequest: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const contextService = { userId: 'admin-user' };
  const lifecycleService = {
    executeInterruptibleProvision: vi
      .fn()
      .mockResolvedValue({ deprovisionJobId: 'd-1', incomingJobId: 'i-1', claimId: 'c-1' }),
  };

  let service: InterruptibleApprovalsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InterruptibleApprovalsService,
        { provide: PrismaClient, useValue: prisma },
        { provide: ContextService, useValue: contextService },
        { provide: LifecycleService, useValue: lifecycleService },
        {
          provide: 'LoggerServiceInterruptibleApprovalsService',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(InterruptibleApprovalsService);
  });

  describe('listPending', () => {
    it('returns pending DEPROVISION requests with a payload summary', async () => {
      prisma.adminLifecycleRequest.findMany.mockResolvedValue([pendingRequest({ requestedBy: { name: 'Ada' } })]);

      const result = await service.listPending();

      expect(prisma.adminLifecycleRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'PENDING', type: 'DEPROVISION' } }),
      );
      expect(result).toEqual([
        {
          id: 'request-1',
          deploymentId: 'outgoing-dep',
          deviceId: 'host-device',
          requestedByName: 'Ada',
          deploymentName: 'new-box',
          operatingSystemSlug: 'ubuntu-22',
          status: 'PENDING',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('authorize', () => {
    it('executes the eviction and marks the request EXECUTED', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(pendingRequest());

      const result = await service.authorize('request-1');

      expect(lifecycleService.executeInterruptibleProvision).toHaveBeenCalledWith({
        deviceId: 'host-device',
        request: expect.objectContaining({ deviceId: 'incoming-device', deploymentName: 'new-box' }),
        expectedDeploymentId: 'outgoing-dep',
      });
      expect(prisma.adminLifecycleRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'request-1' },
          data: expect.objectContaining({
            status: 'EXECUTED',
            approvedById: 'admin-user',
          }),
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('throws 404 when the request does not exist', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(null);
      await expect(service.authorize('missing')).rejects.toBeInstanceOf(HttpException);
      expect(lifecycleService.executeInterruptibleProvision).not.toHaveBeenCalled();
    });

    it('throws 400 when the request is not PENDING', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(
        pendingRequest({ status: AdminLifecycleRequestStatus.EXECUTED }),
      );

      await expect(service.authorize('request-1')).rejects.toThrow(/status EXECUTED/);
      expect(lifecycleService.executeInterruptibleProvision).not.toHaveBeenCalled();
      expect(prisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('marks a PENDING request REJECTED', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(pendingRequest());

      const result = await service.reject('request-1');

      expect(prisma.adminLifecycleRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'request-1' },
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('throws 400 when the request is not PENDING', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(
        pendingRequest({ status: AdminLifecycleRequestStatus.REJECTED }),
      );

      await expect(service.reject('request-1')).rejects.toThrow(/status REJECTED/);
      expect(prisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });
  });
});
