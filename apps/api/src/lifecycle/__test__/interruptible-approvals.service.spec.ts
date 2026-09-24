import { BadRequestException, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminLifecycleRequestStatus, RequestSource } from '@repo/database';
import { ContractType, reservedRollingOnlyRejectionMessage } from '@repo/utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptibleApprovalsService } from '../interruptible-approvals.service';

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

  let service: InterruptibleApprovalsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [InterruptibleApprovalsService, { provide: PrismaClient, useValue: prisma }],
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
    it('rejects interruptible takeovers until commerce billing is ready', async () => {
      await expect(service.authorize('request-1')).rejects.toMatchObject({
        response: { message: reservedRollingOnlyRejectionMessage(ContractType.INTERRUPTIBLE) },
      });
      expect(prisma.adminLifecycleRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.adminLifecycleRequest.update).not.toHaveBeenCalled();
    });

    it('rejects even when a pending request exists', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(pendingRequest());
      await expect(service.authorize('request-1')).rejects.toBeInstanceOf(BadRequestException);
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

    it('throws 404 when the request does not exist', async () => {
      prisma.adminLifecycleRequest.findUnique.mockResolvedValue(null);
      await expect(service.reject('missing')).rejects.toBeInstanceOf(HttpException);
    });
  });
});
