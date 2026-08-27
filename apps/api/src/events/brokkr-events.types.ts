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

    // Single-bridge outage inside an otherwise-online zone (zone.alert covers whole-zone outages).
    'bridge.alert': {
      deviceId: string;
      instanceId: string;
      zoneId: string;
      zoneName: string;
      lastSeenAt: Date;
      offlineSince: Date;
      timeSinceLastSeenSeconds: number;
      bridgeVersion: string | null;
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
