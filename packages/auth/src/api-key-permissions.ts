import { z } from 'zod';

const PermissionRecordSchema = z.record(z.string(), z.array(z.string()));

export type ApiKeyPermissionScope =
  | { kind: 'inherit' }
  | { kind: 'explicit'; permissions: string[] }
  | { kind: 'malformed' };

// Mutating api-key actions are a standing escalation path if a scoped key leaks, so they are never
// delegable; `api-key:read` carries no such risk and stays delegable.
const NON_DELEGABLE_API_KEY_ACTIONS = new Set([
  'api-key:create',
  'api-key:update',
  'api-key:delete',
  'admin.deployment-keys:create',
]);

export function isGrantableApiKeyPermission(permission: string): boolean {
  return (
    !NON_DELEGABLE_API_KEY_ACTIONS.has(permission) &&
    !permission.endsWith(':manage-owners') &&
    !permission.endsWith('-api-keys')
  );
}

export function permissionKeysToRecord(keys: string[]): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  for (const key of keys) {
    const separator = key.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const resource = key.slice(0, separator);
    const action = key.slice(separator + 1);
    (record[resource] ??= []).push(action);
  }
  return record;
}

export function parseApiKeyPermissionScope(raw: unknown): ApiKeyPermissionScope {
  if (raw == null) {
    return { kind: 'inherit' };
  }

  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { kind: 'malformed' };
  }

  const record = PermissionRecordSchema.safeParse(value);
  if (!record.success) {
    return { kind: 'malformed' };
  }

  const permissions = Object.entries(record.data).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  );
  return permissions.length === 0 ? { kind: 'inherit' } : { kind: 'explicit', permissions };
}

// Delegability (`isGrantableApiKeyPermission`) gates only what a scope can be SET to at grant time —
// never re-filter a stored scope here. Inherit mirrors the owner's live role; explicit is capped by it.
export function resolveEffectiveApiKeyPermissions(
  raw: unknown,
  livePermissions: ReadonlySet<string>,
): { permissions: Set<string>; malformed: boolean } {
  const scope = parseApiKeyPermissionScope(raw);

  if (scope.kind === 'inherit') {
    return { permissions: new Set(livePermissions), malformed: false };
  }
  if (scope.kind === 'malformed') {
    return { permissions: new Set(), malformed: true };
  }
  return {
    permissions: new Set(scope.permissions.filter((permission) => livePermissions.has(permission))),
    malformed: false,
  };
}

export function parseApiKeyPermissions(raw: unknown): string[] {
  const scope = parseApiKeyPermissionScope(raw);
  return scope.kind === 'explicit' ? scope.permissions : [];
}
