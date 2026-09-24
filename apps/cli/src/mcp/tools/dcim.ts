import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listBridges } from '../../core/dcim/bridges.js';
import { getDatacenter, listDatacenters } from '../../core/dcim/datacenters.js';
import {
  decommissionServer,
  provisionServer,
  updateServerListing,
  updateServerSettings,
} from '../../core/dcim/mutations.js';
import { getServer, listServers } from '../../core/dcim/servers.js';
import { customizationsSchema, DiskLayoutSchema } from '../../core/deployments/schemas.js';
import { paginationSchema, withClient } from '../shared.js';

const deviceIdSchema = { deviceId: z.string().describe('Device ID') };

const provisioningSchema = {
  deploymentName: z.string().min(1).describe('Name for the resulting deployment'),
  operatingSystem: z
    .string()
    .describe('Base layer slug from get_server availableBaseLayers (e.g. "ubuntu-noble-vanilla")'),
  customizations: customizationsSchema,
  sshKeyIds: z
    .array(z.string().uuid())
    .min(1, 'At least one SSH key is required')
    .describe('List of SSH key IDs to install (at least one required)'),
  diskLayouts: DiskLayoutSchema.describe('Disk layout configuration array'),
  cloudInit: z.string().optional().nullable().describe('Cloud-init user data (YAML string)'),
  ipxeUrl: z.string().optional().describe('iPXE boot URL (overrides OS selection)'),
  projectId: z.string().optional().describe('Project ID to assign the deployment to'),
};

export function registerDcimTools(server: McpServer) {
  server.tool(
    'list_datacenters',
    'List all data centers (zones) accessible to the active organization.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by name'),
      sort: z.string().optional().describe('Sort field, e.g. "name" or "-name" for descending'),
    },
    (args) => withClient((client) => listDatacenters(client, args)),
  );

  server.tool(
    'get_datacenter',
    'Get full details for a data center by ID, including address, bridges, and contacts.',
    { id: z.string().describe('Data center (zone) ID') },
    (args) => withClient((client) => getDatacenter(client, args.id)),
  );

  server.tool(
    'list_bridges',
    'List all bridges across data centers.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by name'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listBridges(client, args)),
  );

  server.tool(
    'list_servers',
    'List baremetal servers in the DCIM inventory. Supplier-only. Prices are in cents.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by name'),
      sort: z.string().optional().describe('Sort field'),
      status: z.string().optional().describe('Filter by status'),
    },
    (args) => withClient((client) => listServers(client, args)),
  );

  server.tool(
    'get_server',
    'Get full hardware details for a baremetal server by ID. Supplier-only. Prices are in cents.',
    { id: z.string().describe('Device ID') },
    (args) => withClient((client) => getServer(client, args.id)),
  );

  server.tool(
    'list_decommissioned_servers',
    'List decommissioned baremetal servers. Supplier-only.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by name'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listServers(client, { ...args, role: 'Decommissioned' })),
  );

  server.tool(
    'decommission_server',
    'Mark a baremetal server as decommissioned. Supplier-only.',
    deviceIdSchema,
    (args) => withClient((client) => decommissionServer(client, args.deviceId)),
  );

  server.tool(
    'update_server_settings',
    'Update nickname and eco mode settings for a baremetal server. Supplier-only.',
    {
      ...deviceIdSchema,
      nickname: z.string().optional().describe('Human-readable nickname for the server'),
      ecoMode: z.boolean().optional().describe('Enable or disable eco mode'),
    },
    (args) => withClient((client) => updateServerSettings(client, args.deviceId, args)),
  );

  server.tool(
    'update_server_listing',
    'Update the marketplace listing for a baremetal server. Supplier-only. Prices are in cents per hour.',
    {
      ...deviceIdSchema,
      hourlyPrice: z.number().int().describe('On-demand price in cents per hour'),
      floorHourlyPrice: z.number().int().optional().describe('Floor price for interruptible in cents per hour'),
      isListed: z.boolean().describe('Whether the server is listed on the marketplace'),
      isInterruptibleOnly: z.boolean().optional().describe('Whether the server is only available as interruptible'),
    },
    (args) =>
      withClient((client) => updateServerListing(client, args.deviceId, { ...args, billingFrequency: 'Weekly' })),
  );

  server.tool(
    'provision_server',
    'Provision a baremetal server for a customer. Supplier-only.',
    { ...deviceIdSchema, ...provisioningSchema },
    (args) => withClient((client) => provisionServer(client, args.deviceId, args)),
  );
}
