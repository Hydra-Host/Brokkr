/** Host-provided token for device operations outside the `LifecycleJob` state machine.
 * Trust boundary matches `PLUGIN_LIFECYCLE_REQUESTS` — the plugin must gate callers itself. */
export const PLUGIN_DEVICE_OPS_REQUESTS = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_DEVICE_OPS_REQUESTS');

export interface PluginForceDiscoveryRequest {
  /** Device to run hardware/inventory collection on. */
  deviceId: string;
}

export interface PluginForceDiscoveryResult {
  /** BullMQ job id (or the coalesce key when a duplicate collection was already queued). */
  jobId: string;
}

export interface PluginRunBenchmarksRequest {
  /** Device to run GPU/NCCL benchmarks on. */
  deviceId: string;
}

export type PluginRunBenchmarksResult =
  | { enqueued: true; planId: string; gpuBurnRunId: string; ncclRunId: string }
  | { enqueued: false; skipped: true };

export interface PluginActivateRescueModeRequest {
  /** Device whose active deployment is rebooted into the rescue OS. */
  deviceId: string;
  /** Rescue OS layer slug to boot; the host defaults this when omitted. */
  rescueOsSlug?: string;
}

export interface PluginDeactivateRescueModeRequest {
  /** Device whose active deployment is rebooted back to its primary OS. */
  deviceId: string;
}

export interface PluginRequestDeviceHealthCheckRequest {
  /** Device the bridge probes now instead of at the next scheduled check. */
  deviceId: string;
}

/** Same shape as api-client's `RequestDeviceHealthCheckResponse`; the SDK carries no api-client dependency. */
export interface PluginRequestDeviceHealthCheckResult {
  /** BullMQ job id of the enqueued `device_health_check` saga. */
  jobId: string;
}

/** Request-side device operations that fall outside the `LifecycleJob` state machine. */
export interface PluginDeviceOpsRequests {
  /** Manually enqueue the `inventory_collection` saga (the same saga the hourly cron runs). */
  requestForceDiscovery(input: PluginForceDiscoveryRequest): Promise<PluginForceDiscoveryResult>;

  /** Enqueue the `benchmarks` saga (GPU burn-in + NCCL) for the device's active deployment. */
  requestRunBenchmarks(input: PluginRunBenchmarksRequest): Promise<PluginRunBenchmarksResult>;

  /** Boot the device's active deployment into a rescue OS. Requires an active, unlocked deployment. */
  requestActivateRescueMode(input: PluginActivateRescueModeRequest): Promise<void>;

  /** Clear the rescue OS and reboot the device's active deployment back to its primary OS. */
  requestDeactivateRescueMode(input: PluginDeactivateRescueModeRequest): Promise<void>;

  /** Enqueue one `device_health_check` saga now; the host refuses offline, non-server, zoneless, rejected-credential and recently checked devices. */
  requestDeviceHealthCheck(input: PluginRequestDeviceHealthCheckRequest): Promise<PluginRequestDeviceHealthCheckResult>;
}
