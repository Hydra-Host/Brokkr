import { OrganizationMembershipRoleSchema } from '@repo/api-client';
import { getConnectionMode, getEnvApiKey, getProcessApiKey } from '../config/env.js';
import { getActiveOrg, getSession, isApiKeySession } from '../config/store.js';
import { fail } from '../ui/format.js';

const MANAGE_ROLES: Set<string> = new Set(OrganizationMembershipRoleSchema.options.filter((r) => r !== 'Member'));

export function canManage(role: string | undefined): boolean {
  if (!role) return false;
  return MANAGE_ROLES.has(role);
}

export function isSupplier(tenantType: string | undefined): boolean {
  if (!tenantType) return false;
  return tenantType === 'SupplyCustomer';
}

export function requireManagePermission(): void {
  if (getConnectionMode() === 'bridge' || isApiKeySession(getSession()) || getProcessApiKey() || getEnvApiKey()) {
    return;
  }

  const org = getActiveOrg();
  if (!org || !org.role) {
    fail('No active organization. Run: brokkr org select');
  }
  if (!canManage(org.role)) {
    fail('This command requires Admin role or higher');
  }
}
