import type { PermissionDefinition } from './types';

export const MAIN_APP_PERMISSIONS: PermissionDefinition[] = [
  { resource: 'organization', action: 'read', description: 'View organization settings', audit: 'read-only' },
  { resource: 'organization', action: 'update', description: 'Update organization settings', audit: 'mutating' },
  { resource: 'organization', action: 'delete', description: 'Delete the organization', audit: 'mutating' },
  {
    resource: 'organization',
    action: 'manage-owners',
    description: 'Grant, remove, and transfer owner access',
    audit: 'mutating',
  },

  { resource: 'member', action: 'read', description: 'View organization members', audit: 'read-only' },
  { resource: 'member', action: 'delete', description: 'Remove members from the organization', audit: 'mutating' },
  { resource: 'member', action: 'change-role', description: 'Change a member role', audit: 'mutating' },

  { resource: 'device', action: 'read', description: 'View devices', audit: 'read-only' },
  { resource: 'device', action: 'create', description: 'Add new devices', audit: 'mutating' },
  { resource: 'device', action: 'update', description: 'Update device configuration', audit: 'mutating' },
  { resource: 'device', action: 'delete', description: 'Remove devices', audit: 'mutating' },
  { resource: 'device', action: 'power-control', description: 'Power on/off/reboot devices', audit: 'mutating' },

  { resource: 'deployment', action: 'read', description: 'View deployments', audit: 'read-only' },
  { resource: 'deployment', action: 'create', description: 'Create new deployments', audit: 'mutating' },
  {
    resource: 'deployment',
    action: 'update',
    description: 'Update deployments (rename, lock, reprovision, rescue mode)',
    audit: 'mutating',
  },
  {
    resource: 'deployment',
    action: 'delete',
    description: 'Deprovision deployments (end the rental)',
    audit: 'mutating',
  },

  { resource: 'lifecycle-request', action: 'read', description: 'View lifecycle requests', audit: 'read-only' },
  { resource: 'lifecycle-request', action: 'create', description: 'Create lifecycle requests', audit: 'mutating' },
  {
    resource: 'lifecycle-request',
    action: 'approve',
    description: 'Approve or reject lifecycle requests',
    audit: 'mutating',
  },

  { resource: 'zone', action: 'read', description: 'View zones', audit: 'read-only' },
  { resource: 'zone', action: 'create', description: 'Create zones', audit: 'mutating' },
  { resource: 'zone', action: 'update', description: 'Update zones', audit: 'mutating' },
  { resource: 'zone', action: 'delete', description: 'Delete zones', audit: 'mutating' },

  { resource: 'api-key', action: 'read', description: 'View API keys', audit: 'read-only' },
  { resource: 'api-key', action: 'create', description: 'Create API keys', audit: 'mutating' },
  { resource: 'api-key', action: 'update', description: 'Edit API key permissions', audit: 'mutating' },
  { resource: 'api-key', action: 'delete', description: 'Revoke API keys', audit: 'mutating' },

  { resource: 'webhook', action: 'read', description: 'View webhooks', audit: 'read-only' },
  { resource: 'webhook', action: 'create', description: 'Create webhooks', audit: 'mutating' },
  { resource: 'webhook', action: 'update', description: 'Update webhooks', audit: 'mutating' },
  { resource: 'webhook', action: 'delete', description: 'Delete webhooks', audit: 'mutating' },

  { resource: 'invitation', action: 'read', description: 'View pending invitations', audit: 'read-only' },
  { resource: 'invitation', action: 'create', description: 'Invite users to the organization', audit: 'mutating' },
  { resource: 'invitation', action: 'delete', description: 'Cancel pending invitations', audit: 'mutating' },

  { resource: 'inventory', action: 'read', description: 'Browse available inventory', audit: 'read-only' },
  { resource: 'inventory', action: 'create', description: 'Provision from inventory', audit: 'mutating' },

  { resource: 'deployment-project', action: 'read', description: 'View deployment projects', audit: 'read-only' },
  { resource: 'deployment-project', action: 'create', description: 'Create deployment projects', audit: 'mutating' },
  {
    resource: 'deployment-project',
    action: 'update',
    description: 'Update deployment projects (rename, move deployments)',
    audit: 'mutating',
  },
  { resource: 'deployment-project', action: 'delete', description: 'Delete deployment projects', audit: 'mutating' },

  { resource: 'ssh-key', action: 'read', description: 'View SSH keys', audit: 'read-only' },
  { resource: 'ssh-key', action: 'create', description: 'Create SSH keys', audit: 'mutating' },
  { resource: 'ssh-key', action: 'delete', description: 'Delete SSH keys', audit: 'mutating' },

  { resource: 'dcim', action: 'read', description: 'View physical infrastructure records', audit: 'read-only' },
  { resource: 'dcim', action: 'create', description: 'Create physical infrastructure records', audit: 'mutating' },
  { resource: 'dcim', action: 'update', description: 'Update physical infrastructure records', audit: 'mutating' },
  { resource: 'dcim', action: 'delete', description: 'Delete physical infrastructure records', audit: 'mutating' },

  { resource: 'ipam', action: 'read', description: 'View IPAM records', audit: 'read-only' },
  { resource: 'ipam', action: 'create', description: 'Create IPAM records', audit: 'mutating' },
  { resource: 'ipam', action: 'update', description: 'Update IPAM records', audit: 'mutating' },
  { resource: 'ipam', action: 'delete', description: 'Delete IPAM records', audit: 'mutating' },

  { resource: 'network', action: 'read', description: 'View BGP sessions, ASNs, and circuits', audit: 'read-only' },
  { resource: 'network', action: 'create', description: 'Create BGP sessions, ASNs, and circuits', audit: 'mutating' },
  { resource: 'network', action: 'update', description: 'Update BGP sessions, ASNs, and circuits', audit: 'mutating' },
  { resource: 'network', action: 'delete', description: 'Delete BGP sessions, ASNs, and circuits', audit: 'mutating' },

  { resource: 'cloud-init-template', action: 'read', description: 'View cloud-init templates', audit: 'read-only' },
  { resource: 'cloud-init-template', action: 'update', description: 'Update cloud-init templates', audit: 'mutating' },
  { resource: 'cloud-init-template', action: 'delete', description: 'Delete cloud-init templates', audit: 'mutating' },

  { resource: 'device-model', action: 'read', description: 'View device models', audit: 'read-only' },
  { resource: 'device-model', action: 'create', description: 'Create device models', audit: 'mutating' },
  { resource: 'device-model', action: 'update', description: 'Update device models', audit: 'mutating' },
  { resource: 'device-model', action: 'delete', description: 'Delete device models', audit: 'mutating' },

  // Deliberately not `read` — Member derives all `:read` keys, and device credentials must never flow there.
  {
    resource: 'device-secret',
    action: 'access',
    description: 'Access device BMC and root credentials',
    audit: 'mutating',
  },

  // Same trick as device-secret: a `:read` key would be auto-granted to every Member.
  // `read-only` for capture — log views are throttled, not recorded as mutations.
  { resource: 'event-log', action: 'access', description: 'View the organization event log', audit: 'read-only' },

  { resource: 'job-log', action: 'access', description: 'View operator job logs', audit: 'read-only' },

  {
    resource: 'zone',
    action: 'register',
    description: 'Mint zone registration tokens for bridge enrollment',
    audit: 'mutating',
  },

  { resource: 'tag', action: 'read', description: 'View tags', audit: 'read-only' },
  { resource: 'tag', action: 'create', description: 'Create tags', audit: 'mutating' },
  { resource: 'tag', action: 'update', description: 'Update tags', audit: 'mutating' },
  { resource: 'tag', action: 'delete', description: 'Delete tags', audit: 'mutating' },

  { resource: 'reservation-invite', action: 'read', description: 'View reservation invites', audit: 'read-only' },
  { resource: 'reservation-invite', action: 'create', description: 'Create reservation invites', audit: 'mutating' },
  { resource: 'reservation-invite', action: 'update', description: 'Update reservation invites', audit: 'mutating' },
  { resource: 'reservation-invite', action: 'delete', description: 'Delete reservation invites', audit: 'mutating' },

  { resource: 'job', action: 'read', description: 'View device lifecycle job history', audit: 'read-only' },
];
