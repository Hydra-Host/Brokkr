import { Injectable } from '@nestjs/common';

import { NonRetryableSagaError } from '../../saga-framework/saga-runner.service';
import type { SagaContext } from '../../saga-framework/saga.types';
import { deviceDataSchema } from '../provision.schema';

interface DeployOrchestrationServiceLike {
  deployOs(params: {
    deviceId: string;
    osPayload: Record<string, unknown>;
    storage: Record<string, unknown>;
    nodeDesc?: string | null;
    deviceNetplan?: string | null;
    deviceGpuModel?: string | null;
    devicePurgeTtys?: boolean;
    deviceSerialPort?: string | null;
    deviceSerialBaud?: number | null;
    deviceType?: string | null;
    deviceNetworkType?: string | null;
  }): Promise<Record<string, unknown>>;
}

interface DeployOrchestrationServiceFactoryLike {
  create(jobId: string, options?: { signal?: AbortSignal; workId?: string }): Promise<DeployOrchestrationServiceLike>;
}

interface LoggerLike {
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

const PAYLOAD_REQUIRED_FIELDS = ['gpu_model', 'purge_ttys', 'serial_port', 'device_type', 'network_type'] as const;

@Injectable()
export class DeployOsStep {
  constructor(
    private readonly factory: DeployOrchestrationServiceFactoryLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | null> {
    if (ctx.deviceId === null || ctx.deviceId === undefined) {
      throw new NonRetryableSagaError('device_id is required for OS deployment');
    }

    const resolveResult = (
      'resolve_deploy_target' in ctx.stepResults ? ctx.stepResults['resolve_deploy_target'] : {}
    ) as Record<string, unknown>;
    if (resolveResult['skipped']) {
      return { skipped: true, reason: 'ipxe_url provided' };
    }

    const osPayload = ('os_payload' in resolveResult ? resolveResult['os_payload'] : {}) as Record<string, unknown>;
    const storage = ('prepare_storage' in ctx.stepResults ? ctx.stepResults['prepare_storage'] : {}) as Record<
      string,
      unknown
    >;

    const deviceDataPayload = (ctx.payload['device_data'] ?? {}) as Record<string, unknown>;

    const missing = PAYLOAD_REQUIRED_FIELDS.filter((k) => !(k in deviceDataPayload));
    if (missing.length > 0) {
      await this.logger.warning(
        `device_data missing payload-required fields [${missing.map((m) => `'${m}'`).join(', ')}] for device ${String(ctx.deviceId)}; using defaults`,
        { jobId: ctx.jobId },
      );
    }

    const deviceData = deviceDataSchema.parse(deviceDataPayload);

    if (!deviceData.netplan) {
      throw new NonRetryableSagaError(
        `device_data.netplan missing from saga payload for device ${String(ctx.deviceId)} — hub failed to render the netplan; cannot deploy`,
      );
    }

    const lifecycleData = ('lifecycle_data' in ctx.payload ? ctx.payload['lifecycle_data'] : {}) as Record<
      string,
      unknown
    >;
    const nodeDesc = lifecycleData['node_desc'];

    const service = await this.factory.create(ctx.jobId, { signal: ctx.signal, workId: ctx.workId });
    return service.deployOs({
      deviceId: String(ctx.deviceId),
      osPayload,
      storage,
      nodeDesc: (nodeDesc ?? null) as string | null,
      deviceNetplan: deviceData.netplan,
      deviceGpuModel: deviceData.gpu_model ?? null,
      devicePurgeTtys: deviceData.purge_ttys,
      deviceSerialPort: deviceData.serial_port ?? null,
      deviceSerialBaud: deviceData.serial_baud ?? null,
      deviceType: deviceData.device_type ?? null,
      deviceNetworkType: deviceData.network_type ?? null,
    });
  }
}
