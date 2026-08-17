// Mirrors of Prisma enums (avoids a @repo/database peer dep); must stay in sync with packages/database/prisma/models/organizations.prisma.

export type OrganizationMembershipRole = 'SuperAdmin' | 'Admin' | 'Member' | 'Owner';

export type TenantType = 'SupplyCustomer' | 'DemandCustomer';
