import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AdminLifecycleRequestStatus } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DeploymentPresenter } from '../deployment.presenter';
import { DeploymentsService } from './deployments.service';

@Injectable()
export class LifecycleRequestsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly deploymentsService: DeploymentsService,
  ) {}

  async getLifecycleRequestsForDeployment(deploymentId: string) {
    this.contextService.requirePermission('lifecycle-request', 'read');
    const aggregate = await this.deploymentsService.getDeploymentAggregate(deploymentId);
    return DeploymentPresenter.lifecycleRequestsToJSON(aggregate);
  }

  async approveLifecycleRequest(deploymentId: string, requestId: string) {
    this.contextService.requirePermission('lifecycle-request', 'approve');
    const aggregate = await this.deploymentsService.getDeploymentAggregate(deploymentId);
    const userId = this.contextService.userId;

    const request = DeploymentPresenter.findLifecycleRequestById(aggregate, requestId);

    if (!request) {
      throw new NotFoundException('Lifecycle request not found');
    }

    if (request.status !== AdminLifecycleRequestStatus.PENDING) {
      throw new HttpException(`Cannot approve a request with status ${request.status}`, HttpStatus.BAD_REQUEST);
    }

    await this.prisma.adminLifecycleRequest.update({
      where: { id: requestId },
      data: {
        status: AdminLifecycleRequestStatus.APPROVED,
        approvedById: userId,
        approvedAt: new Date(),
      },
    });

    return { success: true };
  }

  async rejectLifecycleRequest(deploymentId: string, requestId: string) {
    this.contextService.requirePermission('lifecycle-request', 'approve');
    const aggregate = await this.deploymentsService.getDeploymentAggregate(deploymentId);

    const request = DeploymentPresenter.findLifecycleRequestById(aggregate, requestId);

    if (!request) {
      throw new NotFoundException('Lifecycle request not found');
    }

    if (request.status !== AdminLifecycleRequestStatus.PENDING) {
      throw new HttpException(`Cannot reject a request with status ${request.status}`, HttpStatus.BAD_REQUEST);
    }

    await this.prisma.adminLifecycleRequest.update({
      where: { id: requestId },
      data: {
        status: AdminLifecycleRequestStatus.REJECTED,
        rejectedAt: new Date(),
      },
    });

    return { success: true };
  }
}
