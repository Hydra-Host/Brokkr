import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DeploymentsService } from '../services/deployments.service';

@Controller()
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @TsRestHandler(contract.getDeployments)
  async getDeployments() {
    return tsRestHandler(contract.getDeployments, async ({ query }) => {
      const paginated = await this.deploymentsService.getDeploymentsForOrganizations(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @TsRestHandler(contract.getInterruptibleClaims)
  async getInterruptibleClaims() {
    return tsRestHandler(contract.getInterruptibleClaims, async ({ query }) => {
      const { status, ...paginationQuery } = query;
      const paginated = await this.deploymentsService.getInterruptibleClaims(status, paginationQuery);
      return { status: 200 as const, body: paginated };
    });
  }

  @TsRestHandler(contract.getDeploymentById)
  async getDeploymentById() {
    return tsRestHandler(contract.getDeploymentById, async ({ params }) => {
      const deployment = await this.deploymentsService.getDeploymentById(params.id);
      return { status: 200 as const, body: deployment };
    });
  }

  @TsRestHandler(contract.updateDeploymentNickname)
  async updateDeploymentNickname() {
    return tsRestHandler(contract.updateDeploymentNickname, async ({ params, body }) => {
      const deployment = await this.deploymentsService.updateDeploymentNickname(params.id, body);
      return { status: 200 as const, body: deployment };
    });
  }

  @TsRestHandler(contract.reprovisionDeployment)
  async reprovisionDeployment() {
    return tsRestHandler(contract.reprovisionDeployment, async ({ params, body }) => {
      const job = await this.deploymentsService.reprovisionDirectProvisionDeployment(params.id, {
        deploymentName: body.deploymentName,
        operatingSystem: body.operatingSystem,
        sshKeyIds: body.sshKeyIds,
        diskLayouts: body.diskLayouts,
        cloudInit: body.cloudInit ?? null,
        ipxeUrl: body.ipxeUrl ?? null,
        customizations: body.customizations ?? null,
        tee: body.tee,
      });
      return { status: 200 as const, body: { success: true, jobId: job.data.id } };
    });
  }

  @TsRestHandler(contract.rebootDeployment)
  async rebootDevice() {
    return tsRestHandler(contract.rebootDeployment, async ({ params }) => {
      const job = await this.deploymentsService.rebootDirectProvisionDevice(params.id);
      return { status: 200 as const, body: { success: true, jobId: job.data.id } };
    });
  }

  @TsRestHandler(contract.powerCycleDeployment)
  async powerCycleDevice() {
    return tsRestHandler(contract.powerCycleDeployment, async ({ params }) => {
      const job = await this.deploymentsService.rebootDirectProvisionDevice(params.id);
      return { status: 200 as const, body: { success: true, jobId: job.data.id } };
    });
  }

  @TsRestHandler(contract.powerControlDeployment)
  async powerControlDevice() {
    return tsRestHandler(contract.powerControlDeployment, async ({ params, body }) => {
      const job = await this.deploymentsService.powerControlDevice(params.id, {
        operation: body.operation,
      });
      return { status: 200 as const, body: { success: true, jobId: job.data.id } };
    });
  }

  @TsRestHandler(contract.deprovisionDeployment)
  async deprovisionDevice() {
    return tsRestHandler(contract.deprovisionDeployment, async ({ params }) => {
      const job = await this.deploymentsService.deprovisionDirectProvisionDevice(params.id);
      return { status: 200 as const, body: { success: true, jobId: job.data.id } };
    });
  }

  @TsRestHandler(contract.activateRescueMode)
  async activateRescueMode() {
    return tsRestHandler(contract.activateRescueMode, async ({ params }) => {
      const planId = await this.deploymentsService.activateRescueMode(params.id);
      return { status: 200 as const, body: { success: true, message: 'Rescue mode activated', planId } };
    });
  }

  @TsRestHandler(contract.deactivateRescueMode)
  async deactivateRescueMode() {
    return tsRestHandler(contract.deactivateRescueMode, async ({ params }) => {
      const planId = await this.deploymentsService.deactivateRescueMode(params.id);
      return { status: 200 as const, body: { success: true, message: 'Rescue mode deactivated', planId } };
    });
  }

  @TsRestHandler(contract.getLogs)
  async getLogs() {
    return tsRestHandler(contract.getLogs, async ({ params, body }) => {
      const logResult = await this.deploymentsService.getLogsForDeploymentJob({
        deploymentId: params.id,
        jobType: body.jobType,
      });
      return { status: 200 as const, body: logResult };
    });
  }

  @TsRestHandler(contract.toggleDeploymentLock)
  async toggleDeploymentLock() {
    return tsRestHandler(contract.toggleDeploymentLock, async ({ params }) => {
      const locked = await this.deploymentsService.toggleDeploymentLock(params.id);
      return {
        status: 200 as const,
        body: { success: true, message: locked ? 'Deployment locked' : 'Deployment unlocked' },
      };
    });
  }
}
