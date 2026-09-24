import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { customizationsSchema, DiskLayoutSchema } from '../../core/deployments/schemas.js';
import { getInventoryItem, listInventory, rentInventoryDevice } from '../../core/inventory/inventory.js';
import { paginationSchema, withClient } from '../shared.js';

export function registerInventoryTools(server: McpServer) {
  server.tool(
    'list_inventory',
    'List available servers in the marketplace. Returns paginated inventory with specs, pricing, and availability status.',
    {
      ...paginationSchema,
      filters: z.string().optional().describe('URL-encoded filter criteria for narrowing listings'),
    },
    (args) => withClient((client) => listInventory(client, args)),
  );

  server.tool(
    'get_inventory_item',
    'Get full details for a single available server by device ID. Returns specs, pricing breakdown, available OS images, and default disk layouts.',
    { id: z.string().uuid().describe('Device ID from list_inventory') },
    (args) => withClient((client) => getInventoryItem(client, args.id)),
  );

  server.tool(
    'provision_inventory_device',
    'Rent an available server from the marketplace. Creates a new deployment for the organization. Use get_inventory_item first to see available OS images and disk layouts.',
    {
      id: z.string().uuid().describe('Device ID to rent'),
      deploymentName: z.string().min(1).describe('Name for the new deployment'),
      operatingSystem: z
        .string()
        .describe('Base layer slug from get_inventory_item availableBaseLayers (e.g. "ubuntu-plucky-vanilla")'),
      customizations: customizationsSchema,
      sshKeyIds: z
        .array(z.string().uuid())
        .min(1, 'At least one SSH key is required')
        .describe('SSH key IDs to deploy (use list_api_keys or org SSH keys endpoint; at least one required)'),
      projectId: z.string().uuid().optional().describe('Project ID to assign the deployment to'),
      diskLayouts: DiskLayoutSchema.describe(
        'Disk layout configuration array (use defaultDiskLayouts from get_inventory_item)',
      ),
      cloudInit: z.string().optional().nullable().describe('Cloud-init user data (YAML string)'),
      ipxeUrl: z.string().url().optional().nullable().describe('Custom iPXE boot URL (must be HTTPS)'),
    },
    (args) =>
      withClient((client) =>
        rentInventoryDevice(client, args.id, {
          deploymentName: args.deploymentName,
          operatingSystem: args.operatingSystem,
          sshKeyIds: args.sshKeyIds,
          projectId: args.projectId,
          diskLayouts: args.diskLayouts,
          cloudInit: args.cloudInit ?? null,
          ipxeUrl: args.ipxeUrl ?? null,
          customizations: args.customizations ?? null,
        }),
      ),
  );
}
