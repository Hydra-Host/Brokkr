import type {
  PluginDeprovisionRequest,
  PluginLifecycleDeprovisionRequest,
  PluginLifecycleJobRef,
  PluginLifecycleRequests,
  PluginPowerControlRequest,
  PluginProvisionRequest,
  PluginRebootRequest,
  PluginReprovisionRequest,
} from '@hydrahost/plugin-sdk';
import { Injectable } from '@nestjs/common';
import { OperatingSystemSlugSchema, ReprovisionDiskLayoutSchema } from '@repo/api-client';
import { RequestSource } from '@repo/database';
import type { LifecycleJobRecord } from '@repo/lifecycle';
import { z } from 'zod';

import { LifecycleService } from './lifecycle.service';
import { ProvisionRequestSchema } from './operations/provision.operation';

// The SDK's structural types are looser than the engine's (plain-string OS slug,
// unhardened disk layouts), so every plugin request re-parses through the engine's schemas.
const PluginReprovisionRequestSchema = z.object({
  deviceId: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  deploymentName: z.string(),
  operatingSystemSlug: OperatingSystemSlugSchema,
  sshKeyIds: z.array(z.string()),
  diskLayouts: z.array(ReprovisionDiskLayoutSchema),
  cloudInit: z.string().nullable(),
  ipxeUrl: z.string().nullable(),
  customizations: z.array(z.string()).nullable(),
  tee: z.boolean().optional(),
  passwordHash: z.string().nullable().optional(),
  source: z.nativeEnum(RequestSource),
});

const RequestSourceSchema = z.nativeEnum(RequestSource);

function toJobRef(job: LifecycleJobRecord): PluginLifecycleJobRef {
  return { jobId: job.data.id, jobType: job.data.jobType, phase: job.data.phase };
}

// No authz here by design: plugins gate their own callers (operator-only) — the
// trust boundary is documented on the `PLUGIN_LIFECYCLE_REQUESTS` SDK token.
@Injectable()
export class HostPluginLifecycleRequests implements PluginLifecycleRequests {
  constructor(private readonly lifecycle: LifecycleService) {}

  async requestProvision(input: PluginProvisionRequest): Promise<PluginLifecycleJobRef> {
    const request = ProvisionRequestSchema.parse(input);
    return toJobRef(await this.lifecycle.requestProvisionAsOperator(request));
  }

  async requestReprovision(input: PluginReprovisionRequest): Promise<PluginLifecycleJobRef> {
    // Rebuilt field-by-field: with strictNullChecks off the Zod-inferred shape is
    // all-optional and not assignable to the required-field ReprovisionRequest.
    const parsed = PluginReprovisionRequestSchema.parse(input);
    return toJobRef(
      await this.lifecycle.requestReprovision({
        deviceId: parsed.deviceId,
        userId: parsed.userId,
        organizationId: parsed.organizationId,
        deploymentName: parsed.deploymentName,
        operatingSystemSlug: parsed.operatingSystemSlug,
        sshKeyIds: parsed.sshKeyIds,
        diskLayouts: parsed.diskLayouts,
        cloudInit: parsed.cloudInit,
        ipxeUrl: parsed.ipxeUrl,
        customizations: parsed.customizations,
        tee: parsed.tee,
        passwordHash: parsed.passwordHash,
        source: parsed.source,
      }),
    );
  }

  async requestDeprovision(input: PluginDeprovisionRequest): Promise<PluginLifecycleJobRef> {
    return toJobRef(
      await this.lifecycle.requestDeprovision({
        deviceId: input.deviceId,
        userId: input.userId,
        organizationId: input.organizationId,
        source: RequestSourceSchema.parse(input.source),
        gateOverride: input.gateOverride,
      }),
    );
  }

  async requestLifecycleDeprovision(input: PluginLifecycleDeprovisionRequest): Promise<PluginLifecycleJobRef> {
    return toJobRef(
      await this.lifecycle.requestDeprovisionWithoutDeployment({
        deviceId: input.deviceId,
        userId: input.userId,
        source: RequestSourceSchema.parse(input.source),
      }),
    );
  }

  async requestReboot(input: PluginRebootRequest): Promise<PluginLifecycleJobRef> {
    return toJobRef(
      await this.lifecycle.requestReboot({
        deviceId: input.deviceId,
        userId: input.userId,
        organizationId: input.organizationId,
        source: RequestSourceSchema.parse(input.source),
      }),
    );
  }

  async requestPowerControl(input: PluginPowerControlRequest): Promise<PluginLifecycleJobRef> {
    return toJobRef(
      await this.lifecycle.requestPowerControl({
        operation: input.operation,
        deviceId: input.deviceId,
        userId: input.userId,
        organizationId: input.organizationId,
        source: RequestSourceSchema.parse(input.source),
      }),
    );
  }
}
