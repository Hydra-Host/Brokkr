import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { DeploymentProjectAggregate, DeploymentProjectRecord } from '../deployment-project.record';
import { DeploymentPresenter } from '../deployment.presenter';
import { DeploymentRecord } from '../deployment.record';
import { DeploymentAggregate } from '../types/deployments.types';

@Injectable()
export class DeploymentsProjectsService {
  constructor(
    @Logger(DeploymentsProjectsService.name) private readonly logger: LoggerService,
    private readonly contextService: ContextService,
  ) {}

  private mapProjectDeployments(project: DeploymentProjectAggregate) {
    return {
      ...project,
      deployments: (project.deployments as DeploymentAggregate[])
        .filter((deployment) => {
          if (!deployment.server?.device) {
            this.logger.warn(
              `Skipping deployment ${deployment.id} (serverId ${deployment.serverId}): server/device is missing`,
            );
            return false;
          }
          return true;
        })
        .map((deployment) => DeploymentPresenter.toResponse(deployment)),
    };
  }

  async createProject({ name, isDefault = false }: { name: string; isDefault?: boolean }) {
    this.contextService.requirePermission('deployment-project', 'create');
    this.logger.log(`Creating deployment project "${name}"`);

    try {
      if (isDefault) {
        await this.demoteCurrentDefault();
      }

      const aggregate = await DeploymentProjectRecord.createForCaller({ name: name.trim(), isDefault });

      this.logger.log(`Successfully created deployment project ${aggregate.id}`);
      return this.mapProjectDeployments(aggregate);
    } catch (error) {
      this.logger.error(`Failed to create deployment project: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getProjectsForOrganization(query: PaginationQuery) {
    this.logger.log(`Fetching deployment projects`);
    try {
      const projects = await DeploymentProjectRecord.findActiveAggregates();
      this.logger.log(`Found ${projects.length} deployment projects`);
      const responses = projects.map((project) => this.mapProjectDeployments(project));
      return paginateArray(responses, query, { searchableFields: [] });
    } catch (error) {
      this.logger.error(`Failed to fetch deployment projects: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getProjectById({ projectId }: { projectId: string }) {
    this.logger.log(`Fetching deployment project ${projectId}`);

    try {
      const project = await DeploymentProjectRecord.findActiveAggregateById(projectId);

      if (!project) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }

      return this.mapProjectDeployments(project);
    } catch (error) {
      this.logger.error(`Failed to fetch deployment project: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async updateProject({ projectId, data }: { projectId: string; data: { name?: string; isDefault?: boolean } }) {
    this.contextService.requirePermission('deployment-project', 'update');
    this.logger.log(`Updating deployment project ${projectId}`);

    try {
      const record = await DeploymentProjectRecord.findActiveById(projectId);
      if (!record) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }

      if (data.isDefault === true && !record.data.isDefault) {
        await this.demoteCurrentDefault({ exceptId: record.data.id });
        record.setAsDefault();
      } else if (data.isDefault === false && record.data.isDefault) {
        throw new BadRequestException('Cannot unset default project. Set another project as default instead.');
      }

      if (data.name !== undefined) {
        record.rename(data.name);
      }

      await record.save();

      const aggregate = await DeploymentProjectRecord.findActiveAggregateById(record.data.id);
      if (!aggregate) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }

      this.logger.log(`Successfully updated deployment project ${projectId}`);
      return this.mapProjectDeployments(aggregate);
    } catch (error) {
      this.logger.error(`Failed to update deployment project: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async deleteProject({ projectId }: { projectId: string }) {
    this.contextService.requirePermission('deployment-project', 'delete');
    this.logger.log(`Deleting deployment project ${projectId}`);

    try {
      const aggregate = await DeploymentProjectRecord.findActiveAggregateById(projectId);
      if (!aggregate) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }

      if (aggregate.isDefault) {
        throw new BadRequestException('Default project cannot be deleted. Set another project as default first.');
      }

      if (aggregate.deployments.length > 0) {
        throw new BadRequestException('Project has deployments and cannot be deleted');
      }

      const allProjects = await DeploymentProjectRecord.findActiveAggregates();

      if (allProjects.length === 1) {
        throw new BadRequestException('Cannot delete the last project');
      }

      const record = DeploymentProjectRecord.fromRow(aggregate) as DeploymentProjectRecord;
      record.softDelete();
      await record.save();

      this.logger.log(`Successfully deleted deployment project ${projectId}`);
      return this.mapProjectDeployments({ ...aggregate, deployments: [] });
    } catch (error) {
      this.logger.error(`Failed to delete deployment project: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async addDeploymentToProject({ projectId, deploymentId }: { projectId: string; deploymentId: string }) {
    this.contextService.requirePermission('deployment-project', 'update');
    this.logger.log(`Adding deployment ${deploymentId} to project ${projectId}`);

    try {
      const record = await DeploymentProjectRecord.findActiveById(projectId);

      if (!record) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }

      const deployment = await DeploymentRecord.findActiveAggregateById(deploymentId);

      if (!deployment) {
        throw new NotFoundException(`Deployment ${deploymentId} not found`);
      }

      const updated = await record.addDeployment(deployment.id);
      this.logger.log(`Successfully added deployment to project ${projectId}`);
      return this.mapProjectDeployments(updated);
    } catch (error) {
      this.logger.error(`Failed to add deployments to project: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async moveDeploymentsToProject({
    targetProjectId,
    sourceProjectId,
    deploymentIds,
  }: {
    targetProjectId: string;
    sourceProjectId: string;
    deploymentIds: string[];
  }) {
    this.contextService.requirePermission('deployment-project', 'update');
    this.logger.log(`Moving ${deploymentIds.length} deployments from project ${sourceProjectId} to ${targetProjectId}`);

    try {
      const [target, source] = await Promise.all([
        DeploymentProjectRecord.findActiveById(targetProjectId),
        DeploymentProjectRecord.findActiveById(sourceProjectId),
      ]);
      if (!target) {
        throw new NotFoundException(`Project ${targetProjectId} not found`);
      }
      if (!source) {
        throw new NotFoundException(`Project ${sourceProjectId} not found`);
      }

      const updatedProjects = await DeploymentProjectRecord.moveDeployments({
        targetProjectId,
        sourceProjectId,
        deploymentIds,
      });

      this.logger.log(
        `Successfully moved ${deploymentIds.length} deployments from project ${sourceProjectId} to ${targetProjectId}`,
      );
      const responses = updatedProjects.map((project) => this.mapProjectDeployments(project));
      return paginateArray(responses, {}, { searchableFields: [] });
    } catch (error) {
      this.logger.error(`Failed to move deployments between projects: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  private async demoteCurrentDefault({ exceptId }: { exceptId?: string } = {}) {
    const currentDefault = await DeploymentProjectRecord.findActiveDefault();
    if (!currentDefault) return;
    if (exceptId && currentDefault.id === exceptId) return;

    const currentRecord = DeploymentProjectRecord.fromRow(currentDefault) as DeploymentProjectRecord;
    currentRecord.unsetDefault();
    await currentRecord.save();
  }
}
