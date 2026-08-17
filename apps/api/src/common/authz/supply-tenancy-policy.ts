export const SUPPLY_TENANCY_POLICY = 'SUPPLY_TENANCY_POLICY';

export interface SupplyTenancyPolicy {
  maxSupplyTenants(): number;
}

export class SingleSupplyTenancyPolicy implements SupplyTenancyPolicy {
  maxSupplyTenants(): number {
    return 1;
  }
}
