import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebhookEventTypeSchema } from '@repo/api-client';
import { z } from 'zod';
import { getApiUrl } from '../../config/env.js';
import { getSession } from '../../config/store.js';
import { getSession as getAuthSession } from '../../core/auth.js';
import { createApiKey, deleteApiKey, getApiKey, listApiKeys } from '../../core/org/api-keys.js';
import { cancelInvitation, createInvitation, getInvitation, listInvitations } from '../../core/org/invitations.js';
import { getMember, listMembers, removeMember, updateMemberRole } from '../../core/org/members.js';
import { getOrgSettings, updateOrgSettings } from '../../core/org/settings.js';
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookStats,
  listWebhookDeliveries,
  listWebhooks,
  retryWebhookDelivery,
  updateWebhook,
} from '../../core/org/webhooks.js';
import { listOrganizations } from '../../core/organizations.js';
import { paginationSchema, withClient, withoutClient } from '../shared.js';

const webhookEventsField = z
  .array(z.string())
  .describe(`Event types to subscribe to. Valid values: ${WebhookEventTypeSchema.options.join(', ')}`);

const webhookEndpointSchema = {
  endpoint: z.string().url().describe('HTTPS URL to deliver events to'),
  description: z.string().optional().describe('Optional description'),
  events: webhookEventsField,
};

export function registerOrgTools(server: McpServer) {
  server.tool('whoami', 'Get the current authenticated user and active organization info.', {}, () =>
    withoutClient(() => {
      const baseUrl = getApiUrl();
      const session = getSession();
      return getAuthSession(baseUrl, session?.cookie);
    }),
  );

  server.tool('list_organizations', 'List all organizations the authenticated user belongs to.', {}, () =>
    withoutClient(listOrganizations),
  );

  server.tool('get_org_settings', 'Get settings for the active organization (name, type, email, country).', {}, () =>
    withClient(getOrgSettings),
  );

  server.tool(
    'update_org_settings',
    'Update settings for the active organization (name, email, country).',
    {
      name: z.string().optional().describe('Organization display name'),
      email: z.string().email().optional().nullable().describe('Organization contact email'),
      country: z.string().optional().nullable().describe('Two-letter ISO country code, e.g. "US"'),
    },
    (args) => withClient((client) => updateOrgSettings(client, args)),
  );

  server.tool(
    'list_members',
    'List members of the active organization.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by name or email'),
      role: z.string().optional().describe('Filter by role, e.g. "Owner", "Admin", "Member"'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listMembers(client, args)),
  );

  server.tool(
    'update_member_role',
    'Update the role of a member in the active organization.',
    {
      memberId: z.string().describe('Membership ID (not user ID)'),
      role: z.string().describe('New role, e.g. "Owner", "Admin", "Member"'),
    },
    (args) => withClient((client) => updateMemberRole(client, args.memberId, args.role)),
  );

  server.tool(
    'remove_member',
    'Remove a member from the active organization.',
    { membershipId: z.string().describe('Membership ID (not user ID)') },
    (args) => withClient((client) => removeMember(client, args.membershipId)),
  );

  server.tool(
    'get_member',
    'Get details for a single organization member by membership ID.',
    { memberId: z.string().min(1).describe('Membership ID (not user ID)') },
    (args) => withClient((client) => getMember(client, args.memberId)),
  );

  server.tool(
    'list_invitations',
    'List pending and sent invitations for the active organization.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by email'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listInvitations(client, args)),
  );

  server.tool(
    'invite_member',
    'Send an invitation to a new member to join the active organization.',
    {
      email: z.string().email().describe('Email address to invite'),
      roleId: z.string().min(1).describe('ID of the system or custom role to assign'),
    },
    (args) => withClient((client) => createInvitation(client, args)),
  );

  server.tool(
    'cancel_invitation',
    'Cancel a pending invitation.',
    { invitationId: z.string().describe('Invitation ID') },
    (args) => withClient((client) => cancelInvitation(client, args.invitationId)),
  );

  server.tool(
    'get_invitation',
    'Get details for a single invitation by ID.',
    { invitationId: z.string().min(1).describe('Invitation ID') },
    (args) => withClient((client) => getInvitation(client, args.invitationId)),
  );

  server.tool(
    'list_api_keys',
    'List API keys for the active organization.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by name'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listApiKeys(client, args)),
  );

  server.tool(
    'get_api_key',
    'Get details for a single API key by ID.',
    { apiKeyId: z.string().min(1).describe('API key ID') },
    (args) => withClient((client) => getApiKey(client, args.apiKeyId)),
  );

  server.tool(
    'create_api_key',
    'Create a new API key for the active organization. The key value is only returned once.',
    {
      name: z.string().min(1).max(32).describe('Display name for the API key, limited to 32 characters'),
      expiresIn: z
        .number()
        .int()
        .positive()
        .max(10 * 365 * 24 * 60 * 60 * 1000)
        .optional()
        .describe('Expiry duration in milliseconds from now, capped at 10 years'),
    },
    (args) => withClient((client) => createApiKey(client, { name: args.name, expiresInMilliseconds: args.expiresIn })),
  );

  server.tool(
    'delete_api_key',
    'Delete an API key from the active organization.',
    { apiKeyId: z.string().describe('API key ID') },
    (args) => withClient((client) => deleteApiKey(client, args.apiKeyId)),
  );

  server.tool(
    'list_webhooks',
    'List webhooks configured for the active organization.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search by endpoint URL'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listWebhooks(client, args)),
  );

  server.tool(
    'get_webhook',
    'Get details for a single webhook by ID.',
    { webhookId: z.string().min(1).describe('Webhook ID') },
    (args) => withClient((client) => getWebhook(client, args.webhookId)),
  );

  server.tool(
    'create_webhook',
    'Create a new webhook endpoint for the active organization. The signing secret is only returned once.',
    {
      ...webhookEndpointSchema,
      isActive: z.boolean().default(true).describe('Whether the webhook is active immediately'),
    },
    (args) => withClient((client) => createWebhook(client, args)),
  );

  server.tool(
    'update_webhook',
    'Update an existing webhook endpoint.',
    {
      webhookId: z.string().describe('Webhook ID'),
      ...webhookEndpointSchema,
      isActive: z.boolean().optional().describe('Whether the webhook is active'),
    },
    (args) => withClient((client) => updateWebhook(client, args.webhookId, args)),
  );

  server.tool(
    'delete_webhook',
    'Delete a webhook endpoint from the active organization.',
    { webhookId: z.string().describe('Webhook ID') },
    (args) => withClient((client) => deleteWebhook(client, args.webhookId)),
  );

  server.tool(
    'list_webhook_deliveries',
    'List recent webhook delivery attempts across all webhooks.',
    {
      ...paginationSchema,
      search: z.string().optional().describe('Search filter'),
      sort: z.string().optional().describe('Sort field'),
    },
    (args) => withClient((client) => listWebhookDeliveries(client, args)),
  );

  server.tool(
    'get_webhook_stats',
    'Get webhook delivery statistics (total, active, failed counts) and recent delivery history.',
    {},
    () => withClient(getWebhookStats),
  );

  server.tool(
    'retry_webhook_delivery',
    'Retry a failed webhook delivery attempt.',
    { deliveryId: z.string().describe('Webhook delivery ID') },
    (args) => withClient((client) => retryWebhookDelivery(client, args.deliveryId)),
  );
}
