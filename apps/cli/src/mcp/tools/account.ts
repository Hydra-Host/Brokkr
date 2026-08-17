import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getProfile, updateProfile } from '../../core/account/profile.js';
import { createSshKey, deleteSshKey, getSshKey, listSshKeys } from '../../core/account/ssh-keys.js';
import { paginationSchema, withClient, withoutClient } from '../shared.js';

export function registerAccountTools(server: McpServer) {
  server.tool(
    'get_profile',
    'Get the current authenticated user profile including name, email, and account details.',
    {},
    () => withoutClient(getProfile),
  );

  server.tool(
    'update_profile',
    'Update the current user profile. Only provided fields are changed.',
    {
      firstName: z.string().min(1).optional().describe('Updated first name'),
      lastName: z.string().min(1).optional().describe('Updated last name'),
    },
    (args) => withClient((client) => updateProfile(client, args)),
  );

  server.tool(
    'list_ssh_keys',
    'List SSH public keys registered for the current user. These keys can be selected during device provisioning.',
    { ...paginationSchema },
    (args) => withClient((client) => listSshKeys(client, args)),
  );

  server.tool(
    'get_ssh_key',
    'Get full details for a single SSH key by ID, including the full public key string and fingerprint.',
    { id: z.string().uuid().describe('SSH key ID from list_ssh_keys') },
    (args) => withClient((client) => getSshKey(client, args.id)),
  );

  server.tool(
    'create_ssh_key',
    'Register a new SSH public key for the current user. The key will be available for future deployments.',
    {
      name: z.string().min(1).describe('Display name for the key (e.g. "My Laptop")'),
      key: z.string().min(1).describe('SSH public key in OpenSSH format (e.g. "ssh-ed25519 AAAA... user@host")'),
    },
    (args) => withClient((client) => createSshKey(client, args)),
  );

  server.tool(
    'delete_ssh_key',
    'Soft-delete an SSH key by ID. The key will no longer be available for new provisioning operations.',
    { id: z.string().uuid().describe('SSH key ID to delete') },
    (args) => withClient((client) => deleteSshKey(client, args.id)),
  );
}
