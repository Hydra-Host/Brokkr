import type {} from '@hydrahost/plugin-sdk';
import type { BillingFrequency, JobType, RequestSource } from '@repo/database';

declare module '@hydrahost/plugin-sdk' {
  interface BrokkrEventMap {
    'lifecycle.dispatched': {
      jobId: string;
      jobType: JobType;
      deviceId: string;
      /** Pre-resolved deployment (deprovision ends it during dispatch — audit must use this id, not a post-dispatch lookup); null when not pre-resolved (reboot/power). */
      deploymentId: string | null;
      organizationId: string | null;
      source: RequestSource;
      performedBy: string;
    };

    'cluster.attached': {
      deploymentId: string;
      clusterId: string;
      organizationId: string | null;
    };

    'cluster.detached': {
      deploymentId: string;
      clusterId: string | null;
      organizationId: string | null;
    };

    'provision.completed': LifecycleOutcome;
    'provision.failed': LifecycleOutcome & { error: string; cause?: string };
    'reprovision.completed': LifecycleOutcome;
    'deprovision.completed': LifecycleOutcome;
    'deprovision.failed': LifecycleOutcome & { error: string };

    'deployment.interruption.scheduled': {
      deploymentId: string;
      organizationId: string | null;
      interruptAt: Date;
    };

    'deployment.interruption.completed': {
      deploymentId: string;
      organizationId: string | null;
    };

    'deployment.interruption.queued': {
      incomingOrgId: string;
      deviceId: string;
      deploymentName: string;
      delayMs: number;
    };

    'provision.started': {
      jobId: string;
      deviceId: string;
      deploymentId: string;
      organizationId: string | null;
      internalProvision: boolean;
      manualBilling: boolean;
      billingFrequency: BillingFrequency;
      reservationPrice: number | null;
      deviceName: string;
      deviceClass: string;
      supplierOrganizationId: string | null;
    };

    'lifecycle.deferred': {
      jobId: string;
      jobType: JobType;
      deviceId: string;
      deploymentId: string | null;
      organizationId: string | null;
      source: RequestSource;
      performedBy: string;
      reason: string;
    };
  }
}

interface LifecycleOutcome {
  jobId: string;
  jobType: JobType;
  deviceId: string | null;
  deploymentId: string | null;
  organizationId: string | null;
}

export {};
