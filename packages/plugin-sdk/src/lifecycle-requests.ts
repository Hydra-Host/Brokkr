/** Host-provided token for requesting device lifecycle operations from a plugin; the host binds the core lifecycle engine, which owns gating, bridge dispatch, and billing compensation.
 * Trust boundary: an unrestricted cross-tenant surface — identity is not checked against the request context, so the plugin must gate callers (e.g. `PluginRequestContext.requireInstanceOperator()`). */
export const PLUGIN_LIFECYCLE_REQUESTS = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_LIFECYCLE_REQUESTS');

// Mirrors Prisma `enum RequestSource` (`packages/database/prisma/models/deployment.prisma`).
// Update both in the same commit when adding or renaming members.
export type PluginRequestSource = 'UI' | 'API' | 'DEVICE' | 'ADMIN' | 'SYSTEM';

/** Structural mirror of the host's provision disk layout — a convenience shape, not the enforcement
 * boundary: the host re-validates every request against its own Zod schemas (shell-injection hardening included). */
export interface PluginProvisionDiskLayout {
  /** Disk layout strategy (e.g. `direct`, `lvm`, `raid1`). */
  config: string;
  /** Filesystem format; the host accepts only `ext4` | `xfs`. */
  format: string;
  /** Absolute mount path; validated by the host against its hardening rules. */
  mountpoint: string;
  /** Disk medium (e.g. `NVMe`, `SSD`, `HDD`). */
  diskType: string;
  /** Device names included in the layout. */
  disks: string[];
  /** Encrypt the filesystem (LUKS). */
  encrypt?: boolean;
}

/** Reprovision layout — adds `wipe` (false preserves existing data on the layout). */
export interface PluginReprovisionDiskLayout extends PluginProvisionDiskLayout {
  wipe: boolean;
}

/** Common identity + attribution fields every lifecycle request carries. */
export interface PluginLifecycleActor {
  /** Device the operation targets. */
  deviceId: string;
  /** User the job is attributed to (`performedBy`). */
  userId: string;
  /** How the request originated; operator plugins should pass `ADMIN`. */
  source: PluginRequestSource;
}

export interface PluginProvisionRequest extends PluginLifecycleActor {
  /** Organization the deployment/reservation is created for. */
  organizationId: string;
  deploymentName: string;
  operatingSystemSlug: string;
  sshKeyIds: string[];
  diskLayouts: PluginProvisionDiskLayout[];
  projectId?: string;
  /** Base64-encoded cloud-init JSON, or null. */
  cloudInit: string | null;
  ipxeUrl: string | null;
  /** OS-layer customization slugs, or null for none. */
  customizations: string[] | null;
  tee?: boolean;
  /** Hashed OS login password, or null/undefined when none was set. */
  passwordHash?: string | null;
  /** Internal (non-billed) provision — e.g. an operator test deployment. */
  internalProvision?: boolean;
}

export interface PluginReprovisionRequest extends PluginLifecycleActor {
  /** Organization whose SSH keys are being deployed (the engine resolves the deployment's customer itself). */
  organizationId: string;
  deploymentName: string;
  operatingSystemSlug: string;
  sshKeyIds: string[];
  diskLayouts: PluginReprovisionDiskLayout[];
  /** Base64-encoded cloud-init JSON, or null. */
  cloudInit: string | null;
  ipxeUrl: string | null;
  customizations: string[] | null;
  tee?: boolean;
  passwordHash?: string | null;
}

export interface PluginDeprovisionRequest extends PluginLifecycleActor {
  /** Organization owning the active deployment being deprovisioned. */
  organizationId: string;
  /** Privileged: force past plugin gate vetoes (operator override). */
  gateOverride?: boolean;
}

/** Lifecycle-only deprovision for a device with NO active deployment — resets a stuck
 * device (wipe + return to inventory). No organization/billing context applies. */
export type PluginLifecycleDeprovisionRequest = PluginLifecycleActor;

export interface PluginRebootRequest extends PluginLifecycleActor {
  /** Organization the job is attributed to, or null when none applies. */
  organizationId: string | null;
}

export interface PluginPowerControlRequest extends PluginRebootRequest {
  operation: 'on' | 'off';
}

/** Reference to the created lifecycle job (the engine's `LifecycleJob` row). */
export interface PluginLifecycleJobRef {
  jobId: string;
  /** `Provision` | `Reprovision` | `Deprovision` | `Reboot` | `PowerOn` | `PowerOff`. */
  jobType: string;
  /** Job phase after the request returned (e.g. `DISPATCHED`, `DEFERRED`). */
  phase: string;
}

/** Request-side lifecycle operations. Every method creates a `LifecycleJob`, runs the engine's
 * authorization gates, and dispatches the bridge saga; failures reject with the engine's own exceptions. */
export interface PluginLifecycleRequests {
  /** Provision a device. Creates the Reservation + Deployment before gating (identity is not checked — see the token's trust boundary). */
  requestProvision(input: PluginProvisionRequest): Promise<PluginLifecycleJobRef>;

  /** Reprovision the device's active deployment (same reservation, new OS/config). */
  requestReprovision(input: PluginReprovisionRequest): Promise<PluginLifecycleJobRef>;

  /** Deprovision the device's active deployment (ends deployment + reservation; wipes the device). */
  requestDeprovision(input: PluginDeprovisionRequest): Promise<PluginLifecycleJobRef>;

  /** Lifecycle-only deprovision for a device with no active deployment (get it unstuck); rejects if one exists. */
  requestLifecycleDeprovision(input: PluginLifecycleDeprovisionRequest): Promise<PluginLifecycleJobRef>;

  /** Hard reboot / power cycle via the device's BMC. */
  requestReboot(input: PluginRebootRequest): Promise<PluginLifecycleJobRef>;

  /** Power the device on or off via its BMC. */
  requestPowerControl(input: PluginPowerControlRequest): Promise<PluginLifecycleJobRef>;
}
