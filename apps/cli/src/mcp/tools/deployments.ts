import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CliApiClient } from '../../core/client.js';
import { getDeployment, listDeploymentProjects, listDeployments } from '../../core/deployments/deployments.js';
import {
  activateRescueMode,
  createDeploymentProject,
  deactivateRescueMode,
  deleteDeploymentProject,
  deprovisionDeployment,
  powerControlDeployment,
  powerCycleDeployment,
  renameDeployment,
  reprovisionDeployment,
  toggleDeploymentLock,
} from '../../core/deployments/mutations.js';
import { customizationsSchema, DiskLayoutSchema } from '../../core/deployments/schemas.js';
import { paginationSchema, withClient } from '../shared.js';

const provisioningSchema = {
  deploymentName: z.string().min(1).describe('Name for the deployment'),
  operatingSystem: z
    .string()
    .describe('Base layer slug from get_deployment availableBaseLayers (e.g. "ubuntu-noble-vanilla")'),
  customizations: customizationsSchema,
  sshKeyIds: z
    .array(z.string().uuid())
    .min(1, 'At least one SSH key is required')
    .describe('List of SSH key IDs to install on the server (at least one required)'),
  diskLayouts: DiskLayoutSchema.describe('Disk layout configuration array'),
  cloudInit: z.string().optional().nullable().describe('Cloud-init user data (YAML string)'),
  ipxeUrl: z.string().optional().describe('iPXE boot URL (overrides OS selection)'),
};

async function ensureUnlocked(client: CliApiClient, id: string): Promise<void> {
  const deployment = await getDeployment(client, id);
  if (deployment.isLocked) {
    throw new Error(`Deployment "${deployment.name}" is locked. Unlock it first via the toggle_deployment_lock tool.`);
  }
}

export function registerDeploymentTools(server: McpServer) {
  server.tool(
    'list_deployments',
    'List all deployments for the active organization. Supports pagination, search, and project filtering.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by deployment name'),
      project: z.string().optional().describe('Filter by project name (partial match)'),
      sort: z.string().optional().describe('Sort field, e.g. "name" or "-name" for descending'),
    },
    (args) => withClient((client) => listDeployments(client, args)),
  );

  server.tool(
    'get_deployment',
    'Get full details for a single deployment by ID, including specs, networking, SSH keys, and lifecycle history.',
    { id: z.string().describe('Deployment ID') },
    (args) => withClient((client) => getDeployment(client, args.id)),
  );

  server.tool(
    'rename_deployment',
    'Rename a deployment.',
    {
      id: z.string().describe('Deployment ID'),
      name: z.string().min(1).describe('New name for the deployment'),
    },
    (args) => withClient((client) => renameDeployment(client, args.id, args.name)),
  );

  server.tool('power_on_deployment', 'Power on a deployment.', { id: z.string().describe('Deployment ID') }, (args) =>
    withClient((client) => powerControlDeployment(client, args.id, 'on')),
  );

  server.tool('power_off_deployment', 'Power off a deployment.', { id: z.string().describe('Deployment ID') }, (args) =>
    withClient((client) => powerControlDeployment(client, args.id, 'off')),
  );

  server.tool(
    'power_cycle_deployment',
    'Power cycle (reboot) a deployment.',
    { id: z.string().describe('Deployment ID') },
    (args) => withClient((client) => powerCycleDeployment(client, args.id)),
  );

  server.tool(
    'activate_rescue_mode',
    'Activate rescue mode on a deployment.',
    { id: z.string().describe('Deployment ID') },
    (args) => withClient((client) => activateRescueMode(client, args.id)),
  );

  server.tool(
    'deactivate_rescue_mode',
    'Deactivate rescue mode on a deployment.',
    { id: z.string().describe('Deployment ID') },
    (args) => withClient((client) => deactivateRescueMode(client, args.id)),
  );

  server.tool(
    'toggle_deployment_lock',
    'Toggle the lock state of a deployment. A locked deployment cannot be deprovisioned or reprovisioned.',
    { id: z.string().describe('Deployment ID') },
    (args) => withClient((client) => toggleDeploymentLock(client, args.id)),
  );

  server.tool(
    'deprovision_deployment',
    'Permanently deprovision a deployment. This is irreversible — the server will be wiped and returned to the supplier. Fails with a clear error if the deployment is locked.',
    { id: z.string().describe('Deployment ID') },
    (args) =>
      withClient(async (client) => {
        await ensureUnlocked(client, args.id);
        return deprovisionDeployment(client, args.id);
      }),
  );

  server.tool(
    'reprovision_deployment',
    'Reprovision an existing deployment with a new OS and configuration. The server will be wiped and reprovisioned. Fails with a clear error if the deployment is locked.',
    { id: z.string().describe('Deployment ID'), ...provisioningSchema },
    (args) =>
      withClient(async (client) => {
        await ensureUnlocked(client, args.id);
        return reprovisionDeployment(client, args.id, args);
      }),
  );

  server.tool(
    'list_deployment_projects',
    'List deployment projects for the active organization.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by project name'),
      sort: z.string().optional().describe('Sort field, e.g. "name:asc"'),
    },
    (args) => withClient((client) => listDeploymentProjects(client, args)),
  );

  server.tool(
    'create_deployment_project',
    'Create a new deployment project.',
    { name: z.string().min(1).describe('Project name') },
    (args) => withClient((client) => createDeploymentProject(client, args.name)),
  );

  server.tool(
    'delete_deployment_project',
    'Delete a deployment project. The project must not be the default and must have no deployments assigned.',
    { projectId: z.string().describe('Project ID to delete') },
    (args) => withClient((client) => deleteDeploymentProject(client, args.projectId)),
  );
}
