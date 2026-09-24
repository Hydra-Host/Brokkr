import type {} from '@hydrahost/plugin-sdk';

declare module '@hydrahost/plugin-sdk' {
  interface BrokkrGateMap {
    'provision.authorize': {
      jobId: string;
      deviceId: string;
      // Empty at authorize time — this gate runs before reservation/deployment create.
      deploymentId: string;
      organizationId: string;
      customerUserId: string;
      internalProvision: boolean;
      manualBilling: boolean;
      // Server-derived: an applicable reservation invite is being consumed (never from the SPA).
      fromInvite: boolean;
      // Server-derived Organization.knownAccount (managed GTM; public BOSS ignores).
      knownAccount: boolean;
      supplierOrganizationId: string | null;
    };

    'deprovision.authorize': {
      jobId: string;
      deviceId: string;
      deploymentId: string;
      organizationId: string;
    };

    'reservation.invite.authorize': {
      supplierOrganizationId: string;
    };
  }
}

// Fail CLOSED: if the handler's breaker is open, abort the operation — never allow-by-default.
export const FAIL_CLOSED_GATES = [
  'provision.authorize',
  'deprovision.authorize',
  'reservation.invite.authorize',
] as const;
