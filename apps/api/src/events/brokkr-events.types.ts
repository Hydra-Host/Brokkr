import type { OrganizationMembershipRole, TenantType } from '@hydrahost/plugin-sdk';

// Public plugin contract: renames break subscribers — keep the old event firing until subscribers migrate, or bump the SDK major.
declare module '@hydrahost/plugin-sdk' {
  interface BrokkrEventMap {
    'organization.created': {
      id: string;
      name: string;
      tenantType: TenantType;
    };

    'member.added': {
      organizationId: string;
      userId: string;
      email: string;
      firstName: string;
      lastName: string;
      role: OrganizationMembershipRole;
    };

    'member.removed': {
      organizationId: string;
      userId: string;
      email: string;
    };

    'zone.alert': {
      zoneId: string;
      zoneName: string;
      lastHeartbeatAt: Date;
      timeSinceHeartbeatSeconds: number;
      deviceCount: number;
      activeRentalsCount: number;
    };

    'device.failed': {
      deviceId: string;
      deviceName: string;
      primaryIp: string | null;
      deployment: {
        id: string;
        customerOrganizationId: string;
        operatingSystemName: string | null;
        deployer: {
          email: string;
          firstName: string;
          lastName: string;
        };
      } | null;
    };
  }
}

export {};
