import { describe, expect, it } from 'vitest';
import {
  isGrantableApiKeyPermission,
  parseApiKeyPermissionScope,
  parseApiKeyPermissions,
  permissionKeysToRecord,
  resolveEffectiveApiKeyPermissions,
} from './api-key-permissions';

describe('API-key permission storage', () => {
  it('round-trips resource and action keys', () => {
    const permissions = ['device:read', 'admin.servers:update'];
    expect(parseApiKeyPermissions(permissionKeysToRecord(permissions)).sort()).toEqual(permissions.sort());
  });

  it('splits permission keys at the first colon', () => {
    expect(permissionKeysToRecord(['device:power:cycle'])).toEqual({ device: ['power:cycle'] });
  });

  it('drops permission keys without a colon', () => {
    expect(permissionKeysToRecord(['device:read', 'malformed'])).toEqual({ device: ['read'] });
  });

  it('parseApiKeyPermissions returns no permissions for undefined', () => {
    expect(parseApiKeyPermissions(undefined)).toEqual([]);
  });

  it('parseApiKeyPermissions parses a valid permission record', () => {
    expect(parseApiKeyPermissions({ device: ['read'] })).toEqual(['device:read']);
  });

  it('parseApiKeyPermissions returns no permissions for an empty record', () => {
    expect(parseApiKeyPermissions({})).toEqual([]);
  });

  it.each([
    ['null', null],
    ['invalid JSON', '{invalid'],
    ['non-array action value', { device: 'read' }],
  ])('parseApiKeyPermissions fails closed for %s', (_label, raw) => {
    expect(parseApiKeyPermissions(raw)).toEqual([]);
  });

  it('parses stored JSON permission records', () => {
    expect(parseApiKeyPermissions('{"device":["read","update"]}')).toEqual(['device:read', 'device:update']);
  });

  it.each([null, undefined, {}, '{}', { device: [] }, '{"device":[]}'])(
    'treats %j as the dynamic inheritance marker',
    (raw) => {
      expect(parseApiKeyPermissionScope(raw)).toEqual({ kind: 'inherit' });
    },
  );

  it.each(['{invalid', ['device:read'], { device: 'read' }, '"device:read"'])(
    'distinguishes malformed scope %j from inheritance',
    (raw) => {
      expect(parseApiKeyPermissionScope(raw)).toEqual({ kind: 'malformed' });
    },
  );

  it('accepts historical object and JSON-string permission records', () => {
    expect(parseApiKeyPermissionScope({ device: ['read'] })).toEqual({
      kind: 'explicit',
      permissions: ['device:read'],
    });
    expect(parseApiKeyPermissionScope('{"device":["read"]}')).toEqual({
      kind: 'explicit',
      permissions: ['device:read'],
    });
  });

  it.each([
    'api-key:create',
    'api-key:update',
    'api-key:delete',
    'organization:manage-owners',
    'organization:manage-api-keys',
  ])('keeps privileged permission %s out of API-key scopes', (permission) => {
    expect(isGrantableApiKeyPermission(permission)).toBe(false);
  });

  it('allows ordinary permissions in API-key scopes', () => {
    expect(isGrantableApiKeyPermission('device:read')).toBe(true);
  });

  it('allows api-key:read in API-key scopes — viewing key metadata carries no escalation risk', () => {
    expect(isGrantableApiKeyPermission('api-key:read')).toBe(true);
  });

  it('intersects explicit scope with live permissions', () => {
    const resolution = resolveEffectiveApiKeyPermissions(
      { device: ['read', 'delete'], deployment: ['create'] },
      new Set(['device:read', 'device:update', 'api-key:update']),
    );

    expect(resolution).toEqual({
      permissions: new Set(['device:read']),
      malformed: false,
    });
  });

  it('an explicit scope granted api-key:read resolves it when the owner still holds it live', () => {
    const resolution = resolveEffectiveApiKeyPermissions(
      { 'api-key': ['read'] },
      new Set(['device:read', 'api-key:read', 'api-key:delete']),
    );

    expect(resolution).toEqual({
      permissions: new Set(['api-key:read']),
      malformed: false,
    });
  });

  it('uses the full live permission set for a null/legacy inherit scope', () => {
    expect(
      resolveEffectiveApiKeyPermissions(null, new Set(['device:read', 'deployment:create', 'api-key:update'])),
    ).toEqual({
      permissions: new Set(['device:read', 'deployment:create', 'api-key:update']),
      malformed: false,
    });
  });

  it('fails closed for malformed scope', () => {
    expect(resolveEffectiveApiKeyPermissions('{invalid', new Set(['device:read']))).toEqual({
      permissions: new Set(),
      malformed: true,
    });
  });
});
