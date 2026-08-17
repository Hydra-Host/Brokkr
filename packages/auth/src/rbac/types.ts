import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@repo/database';

/** Runs inside a mutation's own transaction, so an audit write and the mutation commit or roll back together. */
export type TransactionEmit = (tx: Prisma.TransactionClient) => Promise<void>;

export const OWNER_MANAGEMENT_PERMISSION = 'organization:manage-owners';
export const ownerManagementLockKey = (organizationId: string): string => `owner_management:${organizationId}`;

export interface PermissionDefinition {
  resource: string;
  action: string;
  description: string;
  /** Required, not optional: an unannotated key is a silent audit gap rather than a build error.
   *  Independent of the action name — `event-log:access` reads, `device-secret:access` discloses. */
  audit: 'mutating' | 'read-only';
}

export interface SystemRoleDefinition {
  slug: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface RbacConfig {
  permissions: PermissionDefinition[];
  systemRoles: SystemRoleDefinition[];
}

export interface RolePermissionSource {
  rolePermissions: { permission: { resource: string; action: string } }[];
}

export function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/** Unknown and malformed keys resolve to false: capture is opt-in via the catalog, never inferred. */
export function isMutatingPermission(catalog: readonly PermissionDefinition[], key: string): boolean {
  const separator = key.indexOf(':');
  if (separator < 0) return false;
  const resource = key.slice(0, separator);
  const action = key.slice(separator + 1);
  return catalog.some(
    (permission) => permission.resource === resource && permission.action === action && permission.audit === 'mutating',
  );
}

export function rolePermissionKeys(role: RolePermissionSource): string[] {
  return role.rolePermissions.map(({ permission }) => permissionKey(permission.resource, permission.action));
}

export function normalizePermissionSet(
  catalog: readonly PermissionDefinition[],
  permissions: Iterable<string>,
): Set<string> {
  const configured = new Set(catalog.map((permission) => permissionKey(permission.resource, permission.action)));
  return new Set(Array.from(permissions).filter((permission) => configured.has(permission)));
}

export function permissionsBelongToCatalog(
  catalog: readonly PermissionDefinition[],
  permissions: Iterable<string>,
): boolean {
  const configured = new Set(catalog.map((permission) => permissionKey(permission.resource, permission.action)));
  return Array.from(permissions).every((permission) => configured.has(permission));
}

export function roleBelongsToCatalog(catalog: readonly PermissionDefinition[], role: RolePermissionSource): boolean {
  return permissionsBelongToCatalog(catalog, rolePermissionKeys(role));
}

export function isOwnerCapable(catalog: readonly PermissionDefinition[], permissions: Iterable<string>): boolean {
  if (catalog.length === 0) return false;
  const normalized = normalizePermissionSet(catalog, permissions);
  return catalog.every((permission) => normalized.has(permissionKey(permission.resource, permission.action)));
}

export function strictlyDominates(
  catalog: readonly PermissionDefinition[],
  actorPermissions: Iterable<string>,
  targetPermissions: Iterable<string>,
): boolean {
  const actor = normalizePermissionSet(catalog, actorPermissions);
  const target = normalizePermissionSet(catalog, targetPermissions);
  return (
    Array.from(target).every((permission) => actor.has(permission)) &&
    Array.from(actor).some((permission) => !target.has(permission))
  );
}

export const SYSTEM_ROLE_SLUG_BY_MEMBERSHIP_ROLE = {
  Owner: 'owner',
  SuperAdmin: 'admin',
  Admin: 'admin',
  Member: 'member',
} as const satisfies Record<OrganizationMembershipRole, string>;

export async function requireSystemRoleId(prisma: PrismaClient, role: OrganizationMembershipRole): Promise<string> {
  const slug = SYSTEM_ROLE_SLUG_BY_MEMBERSHIP_ROLE[role];
  const systemRoles = await prisma.organizationMemberRole.findMany({
    where: { slug, isSystem: true, organizationId: null, archivedAt: null },
    select: { id: true },
    take: 2,
  });
  const [systemRole] = systemRoles;
  if (!systemRole || systemRoles.length !== 1) {
    throw new Error(`Required active system role "${slug}" is unavailable or ambiguous (found ${systemRoles.length})`);
  }
  return systemRole.id;
}
