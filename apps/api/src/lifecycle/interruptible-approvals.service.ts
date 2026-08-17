import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { PendingInterruptibleEviction } from '@repo/api-client';
import { AdminLifecycleRequestStatus, AdminLifecycleRequestType } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { LifecycleService } from './lifecycle.service';
import { ProvisionRequestSchema } from './operations/provision.operation';

@Injectable()
export class InterruptibleApprovalsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly lifecycleService: LifecycleService,
    @Logger(InterruptibleApprovalsService.name) private readonly logger: LoggerService,
  ) {}

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

  async authorize(requestId: string): Promise<{ success: boolean }> {
    const request = await this.prisma.adminLifecycleRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Interruptible eviction request not found');
    }
    if (request.status !== AdminLifecycleRequestStatus.PENDING) {
      throw new HttpException(`Cannot authorize a request with status ${request.status}`, HttpStatus.BAD_REQUEST);
    }

    const provisionRequest = ProvisionRequestSchema.parse(request.requestBody);

    // Do NOT pass the admin's context — the request carries the original requester's identity.
    try {
      await this.lifecycleService.executeInterruptibleProvision({
        deviceId: request.deviceId,
        request: provisionRequest,
        expectedDeploymentId: request.deploymentId,
      });
    } catch (error) {
      this.logger.error(
        `Failed to execute interruptible provision for request ${requestId}: ${getErrorMessage(error)}`,
      );
      throw error;
    }

    const now = new Date();
    await this.prisma.adminLifecycleRequest.update({
      where: { id: requestId },
      data: {
        status: AdminLifecycleRequestStatus.EXECUTED,
        approvedById: this.contextService.userId,
        approvedAt: now,
        executedAt: now,
      },
    });

    return { success: true };
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
