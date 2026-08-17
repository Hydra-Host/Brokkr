import { z } from 'zod';
import { DeploymentSchema } from './deployments';

export const CreateDeploymentProjectRequestSchema = z.object({
  name: z.string().min(1).describe('Name for the new project'),
});

export type CreateDeploymentProjectRequest = z.infer<typeof CreateDeploymentProjectRequestSchema>;

export const UpdateDeploymentProjectRequestSchema = z.object({
  name: z.string().min(1).describe('Updated project name'),
  isDefault: z.boolean().describe('Whether to set this as the default project'),
});

export type UpdateDeploymentProjectRequest = z.infer<typeof UpdateDeploymentProjectRequestSchema>;

export const MoveDeploymentsToProjectRequestSchema = z.object({
  deploymentIds: z.array(z.string()).min(1).describe('IDs of deployments to move'),
  sourceProjectId: z.string().describe('ID of the project to move deployments from'),
});

export type MoveDeploymentsToProjectRequest = z.infer<typeof MoveDeploymentsToProjectRequestSchema>;

export const DeploymentProjectSchema = z.object({
  id: z.string().describe('Unique identifier for the project'),
  name: z.string().describe('Project name'),
  isDefault: z.boolean().describe('Whether this is the default project for the organization'),
  organizationId: z.string().describe('Organization that owns this project'),
  createdAt: z.coerce.date().describe('When the project was created'),
  updatedAt: z.coerce.date().describe('When the project was last updated'),
  deletedAt: z.coerce.date().nullable().optional().describe('When the project was soft-deleted, if applicable'),
  deployments: z.array(DeploymentSchema).describe('Deployments assigned to this project'),
});

export type DeploymentProject = z.infer<typeof DeploymentProjectSchema>;
