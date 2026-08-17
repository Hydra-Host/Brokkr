import { Injectable } from '@nestjs/common';
import { LifecyclePreparationService } from 'src/brokkr-bridge/lifecycle/lifecycle-preparation.service';
import { BridgeProvisionService } from 'src/brokkr-bridge/lifecycle/provision.service';

export interface ProvisionDispatchParams {
  deviceId: string;
  jobId: string;
  deploymentName: string;
  operatingSystemSlug: string;
  diskLayouts: Array<Record<string, unknown>>;
  pubkeys: string[];
  cloudInit: string | null;
  ipxeUrl: string | null;
  customizations: string[] | null;
  tee?: boolean;
  passwordHash: string | null;
  deploymentId: string | null;
  status?: 'provisioning' | 'reprovisioning';
}

@Injectable()
export class ProvisionDispatcher {
  constructor(
    private readonly lifecyclePrep: LifecyclePreparationService,
    private readonly bridgeProvision: BridgeProvisionService,
  ) {}

  async dispatch(params: ProvisionDispatchParams): Promise<void> {
    const userData: unknown = params.cloudInit
      ? JSON.parse(Buffer.from(params.cloudInit, 'base64').toString('utf-8'))
      : null;

    await this.lifecyclePrep.prepareForProvision(params.deviceId, params.jobId);

    await this.bridgeProvision.provisionDevice(
      params.deviceId,
      params.jobId,
      params.status ?? 'provisioning',
      {
        hostname: params.deploymentName,
        diskLayouts: params.diskLayouts,
        pubkeys: params.pubkeys,
        userData,
        ipxeUrl: params.ipxeUrl,
        passwordHash: params.passwordHash,
        customizations: params.customizations,
        tee: params.tee,
      },
      params.operatingSystemSlug,
      params.deploymentId,
    );
  }
}
