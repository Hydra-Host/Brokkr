import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { OperatingSystemSlug, ReprovisionDiskLayout } from '@repo/api-client';
import { LayerKind, RequestSource } from '@repo/database';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { ProvisionValidatorService } from 'src/provision/processors';
import { LifecycleRepository } from '../lifecycle.repository';
import { ProvisionDispatcher } from './provision-dispatch';

export interface ReprovisionRequest {
  deviceId: string;
  userId: string;
  organizationId: string;
  deploymentName: string;
  operatingSystemSlug: OperatingSystemSlug;
  sshKeyIds: string[];
  diskLayouts: ReprovisionDiskLayout[];
  cloudInit: string | null;
  ipxeUrl: string | null;
  customizations: string[] | null;
  tee?: boolean;
  passwordHash?: string | null;
  source: RequestSource;
}

export interface ReprovisionContext {
  baseLayerId: string;
  organizationId: string | null;
  deploymentId: string | null;
  pubkeys: string[];
}

@Injectable()
export class ReprovisionOperation {
  constructor(
    private readonly repo: LifecycleRepository,
    private readonly provisionDispatcher: ProvisionDispatcher,
    private readonly provisionValidator: ProvisionValidatorService,
  ) {}

  async assembleContext(input: ReprovisionRequest): Promise<ReprovisionContext> {
    const { device, sshKeys, baseLayer } = await this.repo.fetchReprovisionableDevice(
      input.deviceId,
      input.sshKeyIds,
      input.operatingSystemSlug,
      input.organizationId,
    );

    if (!device) throw new NotFoundException(`Device ${input.deviceId} not found`);
    if (sshKeys.length !== input.sshKeyIds.length) throw new NotFoundException('One or more SSH keys not found');
    if (!baseLayer) throw new NotFoundException('Selected operating system not found');
    if (baseLayer.kind !== LayerKind.BASE) {
      throw new BadRequestException(
        `Operating system ${input.operatingSystemSlug} is not installable (expected kind=BASE, got ${baseLayer.kind})`,
      );
    }
    this.provisionValidator.validateDiskGroupHomogeneity(input.diskLayouts, device.storageDrives);
    this.provisionValidator.validateDiskGroupSizeLimits(input.diskLayouts, device.storageDrives);

    const activeDeployments = device.server?.deployments ?? [];
    return {
      baseLayerId: baseLayer.id,
      organizationId: activeDeployments[0]?.customer.id ?? null,
      deploymentId: activeDeployments[0]?.id ?? null,
      pubkeys: sshKeys.map((key) => key.key),
    };
  }

  async dispatch(params: {
    input: ReprovisionRequest;
    organizationId: string | null;
    baseLayerId: string;
    pubkeys: string[];
    jobId: string;
  }): Promise<void> {
    const { input, organizationId, baseLayerId, pubkeys, jobId } = params;

    if (!organizationId) {
      throw new NotFoundException('Active deployment not found for reprovision');
    }
    const record: DeploymentRecord | null = await DeploymentRecord.findOneUnscoped({
      where: { endDate: null, server: { deviceId: input.deviceId }, customerId: organizationId },
    });
    if (!record) {
      throw new NotFoundException('Active deployment not found for reprovision');
    }

    record
      .updateBaseLayer(baseLayerId)
      .rename(input.deploymentName)
      .updateCustomIpxeScript(input.ipxeUrl ?? '')
      .updateDiskEncryption(input.diskLayouts.some((l) => l.encrypt));
    await record.save();
    await record.updateSshKeys(input.sshKeyIds);

    await this.provisionDispatcher.dispatch({
      deviceId: input.deviceId,
      jobId,
      deploymentName: input.deploymentName,
      operatingSystemSlug: input.operatingSystemSlug,
      diskLayouts: input.diskLayouts,
      pubkeys,
      cloudInit: input.cloudInit,
      ipxeUrl: input.ipxeUrl,
      customizations: input.customizations,
      tee: input.tee,
      passwordHash: input.passwordHash ?? null,
      deploymentId: record.data.id,
      status: 'reprovisioning',
    });
  }
}
