import { TenantType } from '@repo/database';

export interface AllowedOrgTypesProvider {
  getAllowedOrgTypes(): TenantType[];
}

export class DefaultAllowedOrgTypesProvider implements AllowedOrgTypesProvider {
  getAllowedOrgTypes(): TenantType[] {
    return [TenantType.DemandCustomer];
  }
}
