import { describe, expect, it } from 'vitest';
import { RbacService } from '../rbac/rbac.service';
import { MAIN_APP_PERMISSIONS } from '../rbac/main-app-permissions';
import { isMutatingPermission, permissionKey } from '../rbac/types';

describe('permission audit classification', () => {
  it('annotates every catalog entry', () => {
    const unannotated = MAIN_APP_PERMISSIONS.filter((permission) => permission.audit === undefined).map((permission) =>
      permissionKey(permission.resource, permission.action),
    );

    expect(unannotated).toEqual([]);
  });

  it('classifies every read action as read-only', () => {
    const misclassified = MAIN_APP_PERMISSIONS.filter(
      (permission) => permission.action === 'read' && permission.audit !== 'read-only',
    ).map((permission) => permissionKey(permission.resource, permission.action));

    expect(misclassified).toEqual([]);
  });

  it('classifies device-secret access as mutating so every disclosure is logged', () => {
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, 'device-secret:access')).toBe(true);
  });

  it('exposes event-log access as a non-read key that members never derive', () => {
    const entry = MAIN_APP_PERMISSIONS.find(
      (permission) => permission.resource === 'event-log' && permission.action === 'access',
    );

    expect(entry).toBeDefined();
    expect(entry?.audit).toBe('read-only');
  });

  it('does not treat event-log access as a mutation', () => {
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, 'event-log:access')).toBe(false);
  });

  it('treats an unknown key as non-mutating', () => {
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, 'nope:whatever')).toBe(false);
  });

  it('treats a malformed key as non-mutating', () => {
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, 'no-separator')).toBe(false);
  });

  it('classifies a representative mutation as mutating', () => {
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, 'device:update')).toBe(true);
  });

  it('never exposes the audit field through listAllPermissions', () => {
    const service = new RbacService({} as never, { permissions: MAIN_APP_PERMISSIONS, systemRoles: [] });

    const exposed = service.listAllPermissions();

    expect(exposed).toHaveLength(MAIN_APP_PERMISSIONS.length);
    for (const permission of exposed) {
      expect(Object.keys(permission).sort()).toEqual(['action', 'description', 'resource']);
    }
  });
});
