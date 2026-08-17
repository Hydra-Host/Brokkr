import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DeploymentsProjectsService } from '../services/deployments.projects.service';

@Controller()
export class DeploymentsProjectsController {
  constructor(private readonly deploymentsProjectsService: DeploymentsProjectsService) {}

  @TsRestHandler(contract.createDeploymentProject)
  async createProject() {
    return tsRestHandler(contract.createDeploymentProject, async ({ body }) => {
      const project = await this.deploymentsProjectsService.createProject({ name: body.name });
      return { status: 201 as const, body: project };
    });
  }

  @TsRestHandler(contract.getDeploymentProjects)
  async getProjects() {
    return tsRestHandler(contract.getDeploymentProjects, async ({ query }) => {
      const paginated = await this.deploymentsProjectsService.getProjectsForOrganization(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @TsRestHandler(contract.getDeploymentProjectById)
  async getProject() {
    return tsRestHandler(contract.getDeploymentProjectById, async ({ params }) => {
      const project = await this.deploymentsProjectsService.getProjectById({ projectId: params.projectId });
      return { status: 200 as const, body: project };
    });
  }

  @TsRestHandler(contract.updateDeploymentProject)
  async updateProject() {
    return tsRestHandler(contract.updateDeploymentProject, async ({ params, body }) => {
      const project = await this.deploymentsProjectsService.updateProject({
        projectId: params.projectId,
        data: body,
      });
      return { status: 200 as const, body: project };
    });
  }

  @TsRestHandler(contract.deleteDeploymentProject)
  async deleteProject() {
    return tsRestHandler(contract.deleteDeploymentProject, async ({ params }) => {
      const project = await this.deploymentsProjectsService.deleteProject({ projectId: params.projectId });
      return { status: 200 as const, body: project };
    });
  }

  @TsRestHandler(contract.moveDeploymentsToProject)
  async moveDeployments() {
    return tsRestHandler(contract.moveDeploymentsToProject, async ({ params, body }) => {
      const paginated = await this.deploymentsProjectsService.moveDeploymentsToProject({
        targetProjectId: params.projectId,
        sourceProjectId: body.sourceProjectId,
        deploymentIds: body.deploymentIds,
      });
      return { status: 200 as const, body: paginated };
    });
  }
}
