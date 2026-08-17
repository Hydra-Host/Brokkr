export function getLandingRoute(tenantType?: string): string {
  if (tenantType === 'SupplyCustomer') {
    return '/dcim/servers';
  }
  return '/deployments';
}
