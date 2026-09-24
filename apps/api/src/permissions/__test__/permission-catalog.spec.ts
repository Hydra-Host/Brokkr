import { describe, expect, it } from 'vitest';
import { MAIN_APP_PERMISSIONS as CORE_APP_PERMISSIONS } from '@repo/auth/rbac';
import { MAIN_APP_PERMISSIONS, MAIN_APP_SYSTEM_ROLES } from '../permissions.constants';

const key = (resource: string, action: string) => `${resource}:${action}`;
const catalogKeys = new Set(MAIN_APP_PERMISSIONS.map((p) => key(p.resource, p.action)));
const memberPerms = new Set(MAIN_APP_SYSTEM_ROLES.find((r) => r.slug === 'member')!.permissions);
const adminPerms = new Set(MAIN_APP_SYSTEM_ROLES.find((r) => r.slug === 'admin')!.permissions);
const ownerPerms = new Set(MAIN_APP_SYSTEM_ROLES.find((r) => r.slug === 'owner')!.permissions);

const SENSITIVE = ['device-secret:access', 'zone:register', 'cloud-init-template:update'];

describe('permission catalog', () => {
  it.each(SENSITIVE)('%s exists and is not a "read" action', (k) => {
    expect(catalogKeys.has(k)).toBe(true);
    expect(k.endsWith(':read')).toBe(false);
  });

  it.each(SENSITIVE)('the Member role does not grant %s', (k) => {
    expect(memberPerms.has(k)).toBe(false);
  });

  it('every Member permission is a read or an explicit non-read grant (no accidental writes)', () => {
    const allowedNonRead = new Set([
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
    ]);
    for (const k of memberPerms) {
      expect(k.endsWith(':read') || allowedNonRead.has(k)).toBe(true);
    }
  });

  it('has no duplicate resource:action entries', () => {
    expect(catalogKeys.size).toBe(MAIN_APP_PERMISSIONS.length);
  });

  it('reserves owner management for the full-catalog Owner system role', () => {
    expect(ownerPerms.has('organization:manage-owners')).toBe(true);
    expect(ownerPerms).toEqual(catalogKeys);
    expect(adminPerms.has('organization:manage-owners')).toBe(false);
    expect(adminPerms).not.toEqual(catalogKeys);
  });

  it('grants plugin :read keys to Member and withholds their other actions', () => {
    const coreKeys = new Set(CORE_APP_PERMISSIONS.map((p) => key(p.resource, p.action)));
    for (const permission of MAIN_APP_PERMISSIONS) {
      const k = key(permission.resource, permission.action);
      if (coreKeys.has(k)) continue;
      expect(ownerPerms.has(k)).toBe(true);
      expect(adminPerms.has(k)).toBe(true);
      expect(memberPerms.has(k)).toBe(permission.action === 'read');
    }
  });
});
