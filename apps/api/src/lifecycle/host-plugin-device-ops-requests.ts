import type {
  PluginActivateRescueModeRequest,
  PluginDeactivateRescueModeRequest,
  PluginDeviceOpsRequests,
  PluginForceDiscoveryRequest,
  PluginForceDiscoveryResult,
  PluginRunBenchmarksRequest,
  PluginRunBenchmarksResult,
} from '@hydrahost/plugin-sdk';
import { Injectable } from '@nestjs/common';

import { OperatorDeviceOpsService } from './operator-device-ops.service';

// No authz here by design: plugins gate their own callers (operator-only) — the
// trust boundary is documented on the `PLUGIN_DEVICE_OPS_REQUESTS` SDK token.
@Injectable()
export class HostPluginDeviceOpsRequests implements PluginDeviceOpsRequests {
  constructor(private readonly deviceOps: OperatorDeviceOpsService) {}

  async requestForceDiscovery(input: PluginForceDiscoveryRequest): Promise<PluginForceDiscoveryResult> {
    return this.deviceOps.forceDiscovery(input.deviceId);
  }

  async requestRunBenchmarks(input: PluginRunBenchmarksRequest): Promise<PluginRunBenchmarksResult> {
    const result = await this.deviceOps.runBenchmarks(input.deviceId);
    if ('skipped' in result) {
      return { enqueued: false, skipped: true };
    }
    return {
      enqueued: true,
      planId: result.plan_id,
      gpuBurnRunId: result.gpu_burn_run_id,
      ncclRunId: result.nccl_run_id,
    };
  }

  async requestActivateRescueMode(input: PluginActivateRescueModeRequest): Promise<void> {
    await this.deviceOps.activateRescueMode(input.deviceId, input.rescueOsSlug);
  }

  async requestDeactivateRescueMode(input: PluginDeactivateRescueModeRequest): Promise<void> {
    await this.deviceOps.deactivateRescueMode(input.deviceId);
  }
}
