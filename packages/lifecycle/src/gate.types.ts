import type {} from '@hydrahost/plugin-sdk';

declare module '@hydrahost/plugin-sdk' {
  interface BrokkrGateMap {
    'provision.authorize': {
      jobId: string;
      deviceId: string;
      deploymentId: string;
      organizationId: string;
      customerUserId: string;
      internalProvision: boolean;
    };

    'deprovision.authorize': {
      jobId: string;
      deviceId: string;
      deploymentId: string;
      organizationId: string;
    };
  }
}

// Fail CLOSED: if the handler's breaker is open, abort the operation — never allow-by-default.
export const FAIL_CLOSED_GATES = ['provision.authorize', 'deprovision.authorize'] as const;
