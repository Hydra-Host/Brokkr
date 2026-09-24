import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { PendingInterruptibleEviction } from '@repo/api-client';
import { AdminLifecycleRequestStatus, AdminLifecycleRequestType } from '@repo/database';
import { ContractType, reservedRollingOnlyRejectionMessage } from '@repo/utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ProvisionRequestSchema } from './operations/provision.operation';

@Injectable()
export class InterruptibleApprovalsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listPending(): Promise<PendingInterruptibleEviction[]> {
    const requests = await this.prisma.adminLifecycleRequest.findMany({
      where: { status: AdminLifecycleRequestStatus.PENDING, type: AdminLifecycleRequestType.DEPROVISION },
      include: { requestedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return requests.map((request) => {
      const parsed = ProvisionRequestSchema.safeParse(request.requestBody);
      return {
        id: request.id,
        deploymentId: request.deploymentId,
        deviceId: request.deviceId,
        requestedByName: request.requestedBy.name,
        deploymentName: parsed.success ? parsed.data.deploymentName : '',
        operatingSystemSlug: parsed.success ? parsed.data.operatingSystemSlug : '',
        status: request.status,
        createdAt: request.createdAt.toISOString(),
      };
    });
  }

  async authorize(_requestId: string): Promise<{ success: boolean }> {
    throw new BadRequestException(reservedRollingOnlyRejectionMessage(ContractType.INTERRUPTIBLE));
  }

  async reject(requestId: string): Promise<{ success: boolean }> {
    const request = await this.prisma.adminLifecycleRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Interruptible eviction request not found');
    }
    if (request.status !== AdminLifecycleRequestStatus.PENDING) {
      throw new HttpException(`Cannot reject a request with status ${request.status}`, HttpStatus.BAD_REQUEST);
    }

    await this.prisma.adminLifecycleRequest.update({
      where: { id: requestId },
      data: { status: AdminLifecycleRequestStatus.REJECTED, rejectedAt: new Date() },
    });

    return { success: true };
  }
}
