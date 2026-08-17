import { MAIN_APP_PERMISSIONS } from '@repo/auth/rbac';

export interface PermissionDefinition {
  resource: string;
  action: string;
  description: string;
}

export interface SystemRoleDefinition {
  slug: string;
  name: string;
  description: string;
  permissions: string[];
}

function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

export { MAIN_APP_PERMISSIONS };

const allKeys = MAIN_APP_PERMISSIONS.map((p) => permissionKey(p.resource, p.action));
const allKeySet = new Set(allKeys);

function known(...keys: string[]): string[] {
  for (const key of keys) {
    if (!allKeySet.has(key)) {
      throw new Error(`Unknown permission key "${key}" — not defined in MAIN_APP_PERMISSIONS`);
    }
  }
  return keys;
}

function allWithAction(action: string): string[] {
  return allKeys.filter((k) => k.endsWith(`:${action}`));
}

const OWNER_ONLY = new Set(known('organization:delete', 'organization:manage-owners'));

export const MAIN_APP_SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    slug: 'owner',
    name: 'Owner',
    description: 'Full control over the organization',
    permissions: allKeys,
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Full administrative control except deleting the organization',
    permissions: allKeys.filter((k) => !OWNER_ONLY.has(k)),
  },
  {
    slug: 'member',
    name: 'Member',
    description: 'Operational access: provision, deploy, and manage infrastructure records',
    permissions: [
      ...allWithAction('read'),
      // Pre-RBAC parity: removing a key here is a Member-facing regression — do not trim without an explicit product decision.
      ...known(
        'api-key:create',
        'deployment:create',
        'deployment:update',
        'deployment:delete',
        'deployment-project:create',
        'deployment-project:update',
        'deployment-project:delete',
        'lifecycle-request:create',
        'ssh-key:create',
        'ssh-key:delete',
        'inventory:create',
        'device:power-control',
        'ipam:create',
        'dcim:create',
        'network:create',
        'tag:create',
        'zone:create',
        'reservation-invite:create',
        'reservation-invite:update',
        'reservation-invite:delete',
      ),
    ],
  },
];
