export interface PluginPermissionDefinition {
  resource: string;
  action: string;
  description: string;
  /** Capture config, independent of the action name. Same contract as the host catalog. */
  audit: 'mutating' | 'read-only';
}

export interface PluginPermissionSource {
  plugin: {
    id: string;
    permissions?: readonly PluginPermissionDefinition[];
  };
}

const AUDIT_VALUES = new Set<PluginPermissionDefinition['audit']>(['mutating', 'read-only']);

function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

function assertPermissionShape(pluginId: string, permission: PluginPermissionDefinition): void {
  if (permission.resource === '' || permission.resource.includes(':')) {
    throw new Error(
      `Plugin "${pluginId}" permission resource "${permission.resource}" must be a non-empty string without ':'`,
    );
  }
  if (permission.action === '' || permission.action.includes(':')) {
    throw new Error(
      `Plugin "${pluginId}" permission action "${permission.action}" must be a non-empty string without ':'`,
    );
  }
  if (!AUDIT_VALUES.has(permission.audit)) {
    throw new Error(
      `Plugin "${pluginId}" permission ${permissionKey(permission.resource, permission.action)} must set audit to mutating or read-only`,
    );
  }
}

/** Union core + plugin keys. Disabled-but-loaded plugins still contribute so the catalog does not flap with credentials. */
export function mergePluginPermissions(
  core: readonly PluginPermissionDefinition[],
  plugins: readonly PluginPermissionSource[],
): PluginPermissionDefinition[] {
  const merged: PluginPermissionDefinition[] = [...core];
  const owners = new Map<string, string>();
  for (const permission of core) {
    owners.set(permissionKey(permission.resource, permission.action), 'core');
  }

  for (const entry of plugins) {
    const declared = entry.plugin.permissions;
    if (declared === undefined || declared.length === 0) continue;
    for (const permission of declared) {
      assertPermissionShape(entry.plugin.id, permission);
      const key = permissionKey(permission.resource, permission.action);
      const existing = owners.get(key);
      if (existing !== undefined) {
        throw new Error(`Permission "${key}" collided: declared by ${existing} and plugin "${entry.plugin.id}"`);
      }
      owners.set(key, `plugin "${entry.plugin.id}"`);
      merged.push(permission);
    }
  }

  return merged;
}
