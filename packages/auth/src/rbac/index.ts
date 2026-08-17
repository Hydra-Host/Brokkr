export { RBAC_CONFIG } from './constants';
export { MAIN_APP_PERMISSIONS } from './main-app-permissions';
export { PRISMA_CLIENT, RbacResolverService } from './rbac-resolver.service';
export { RbacModule } from './rbac.module';
export type { RbacModuleOptions } from './rbac.module';
export { RbacService } from './rbac.service';
export { seedRbac } from './seed';
export {
  OWNER_MANAGEMENT_PERMISSION,
  SYSTEM_ROLE_SLUG_BY_MEMBERSHIP_ROLE,
  isMutatingPermission,
  isOwnerCapable,
  normalizePermissionSet,
  ownerManagementLockKey,
  permissionKey,
  permissionsBelongToCatalog,
  requireSystemRoleId,
  roleBelongsToCatalog,
  rolePermissionKeys,
  strictlyDominates,
} from './types';
export type {
  PermissionDefinition,
  RbacConfig,
  RolePermissionSource,
  SystemRoleDefinition,
  TransactionEmit,
} from './types';
