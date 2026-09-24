import { describe, expect, it } from 'vitest';

import { mergePluginPermissions, type PluginPermissionDefinition } from '../plugin-permissions';

const CORE: PluginPermissionDefinition[] = [
  { resource: 'organization', action: 'read', description: 'View organization', audit: 'read-only' },
  { resource: 'organization', action: 'update', description: 'Update organization', audit: 'mutating' },
];

const BILLING_READ: PluginPermissionDefinition = {
  resource: 'billing',
  action: 'read',
  description: 'View billing',
  audit: 'read-only',
};

const BILLING_UPDATE: PluginPermissionDefinition = {
  resource: 'billing',
  action: 'update',
  description: 'Update billing',
  audit: 'mutating',
};

describe('mergePluginPermissions', () => {
  it('returns core unchanged when no plugin declares permissions', () => {
    expect(mergePluginPermissions(CORE, [{ plugin: { id: 'webvm-terminal' } }])).toEqual(CORE);
  });

  it('appends keys from all passed plugins', () => {
    const merged = mergePluginPermissions(CORE, [
      {
        plugin: {
          id: 'commerce',
          permissions: [BILLING_READ, BILLING_UPDATE],
        },
      },
    ]);

    expect(merged).toEqual([...CORE, BILLING_READ, BILLING_UPDATE]);
  });

  it('rejects a plugin key that collides with core', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        {
          plugin: {
            id: 'commerce',
            permissions: [{ resource: 'organization', action: 'read', description: 'Nope', audit: 'read-only' }],
          },
        },
      ]),
    ).toThrow('Permission "organization:read" collided: declared by core and plugin "commerce"');
  });

  it('rejects the same key declared by two plugins', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        { plugin: { id: 'commerce', permissions: [BILLING_READ] } },
        { plugin: { id: 'invoices', permissions: [BILLING_READ] } },
      ]),
    ).toThrow('Permission "billing:read" collided: declared by plugin "commerce" and plugin "invoices"');
  });

  it('rejects a resource that contains a colon', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        {
          plugin: {
            id: 'commerce',
            permissions: [{ resource: 'billing:account', action: 'read', description: 'Nope', audit: 'read-only' }],
          },
        },
      ]),
    ).toThrow('resource "billing:account" must be a non-empty string without \':\'');
  });

  it('rejects an empty resource', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        {
          plugin: {
            id: 'commerce',
            permissions: [{ resource: '', action: 'read', description: 'Nope', audit: 'read-only' }],
          },
        },
      ]),
    ).toThrow('resource "" must be a non-empty string without \':\'');
  });

  it('rejects an empty action', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        {
          plugin: {
            id: 'commerce',
            permissions: [{ resource: 'billing', action: '', description: 'Nope', audit: 'read-only' }],
          },
        },
      ]),
    ).toThrow('action "" must be a non-empty string without \':\'');
  });

  it('rejects an action that contains a colon', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        {
          plugin: {
            id: 'commerce',
            permissions: [{ resource: 'billing', action: 'read:all', description: 'Nope', audit: 'read-only' }],
          },
        },
      ]),
    ).toThrow('action "read:all" must be a non-empty string without \':\'');
  });

  it('rejects an audit value other than mutating or read-only', () => {
    expect(() =>
      mergePluginPermissions(CORE, [
        {
          plugin: {
            id: 'commerce',
            permissions: [
              {
                resource: 'billing',
                action: 'read',
                description: 'Nope',
                // @ts-expect-error runtime guard for untyped manifests
                audit: 'invalid',
              },
            ],
          },
        },
      ]),
    ).toThrow('must set audit to mutating or read-only');
  });
});
