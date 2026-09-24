import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { OperatingSystemSlugSchema, provisionDiskLayoutSchema } from '@repo/api-client';
import { DeploymentType, LayerKind, RequestSource } from '@repo/database';
import { DEFAULT_INTERRUPTIBLE_NOTICE_MS } from '@repo/lifecycle';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { DEPLOYMENTS_SERVICE } from 'src/deployments/deployments.tokens';
import type { DeploymentsService } from 'src/deployments/services/deployments.service';
import { LoggerService } from 'src/logger/logger.service';
import { ProvisionValidatorService } from 'src/provision/processors';
import {
  ReservationProvisioningService,
  type BilledProvisionLine,
} from 'src/reservations/reservation-provisioning.service';
import { z } from 'zod';
import { LifecycleRepository } from '../lifecycle.repository';
import { ProvisionDispatcher } from './provision-dispatch';

export const ProvisionRequestSchema = z.object({
  deviceId: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  deploymentName: z.string(),
  operatingSystemSlug: OperatingSystemSlugSchema,
  sshKeyIds: z.array(z.string()),
  diskLayouts: z.array(provisionDiskLayoutSchema),
  projectId: z.string().optional(),
  cloudInit: z.string().nullable(),
  ipxeUrl: z.string().nullable(),
  customizations: z.array(z.string()).nullable(),
  tee: z.boolean().default(false),
  passwordHash: z.string().nullable().optional(),
  source: z.nativeEnum(RequestSource),
  internalProvision: z.boolean().default(false),
  isInterruptible: z.boolean().default(false),
  interruptibleNoticePeriod: z.number().nullable().optional(),
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export interface ProvisionContext {
  baseLayerId: string;
  pubkeys: string[];
  supplierOrganizationId: string | null;
}

@Injectable()
export class ProvisionOperation {
  constructor(
    private readonly context: ContextService,
    private readonly repo: LifecycleRepository,
    @Inject(DEPLOYMENTS_SERVICE) private readonly deploymentsService: DeploymentsService,
    private readonly provisionDispatcher: ProvisionDispatcher,
    private readonly provisionValidator: ProvisionValidatorService,
    private readonly reservationProvisioning: ReservationProvisioningService,
    @Logger(ProvisionOperation.name) private readonly logger: LoggerService,
  ) {}

  async createReservation(input: ProvisionRequest): Promise<string> {
    return this.reservationProvisioning.createForProvision({
      deviceId: input.deviceId,
      userId: input.userId,
      organizationId: input.organizationId,
      internalProvision: input.internalProvision,
      isInterruptible: input.isInterruptible,
    });
  }

  resolveProvisionInviteFlags(input: {
    deviceId: string;
    userId: string;
    organizationId: string;
  }): Promise<{ fromInvite: boolean; manualBilling: boolean }> {
    return this.reservationProvisioning.resolveProvisionInviteFlags(input);
  }

  isKnownAccount(organizationId: string): Promise<boolean> {
    return this.reservationProvisioning.isKnownAccount(organizationId);
  }

  billedLineForDeployment(deploymentId: string): Promise<BilledProvisionLine> {
    return this.reservationProvisioning.billedLineForDeployment(deploymentId);
  }

  async acceptInvite(reservationId: string): Promise<void> {
    try {
      if (await this.reservationProvisioning.acceptInviteForReservation(reservationId)) {
        this.logger.log(`Accepted reservation invite for reservation ${reservationId}`);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to accept reservation invite for reservation ${reservationId}: ${getErrorMessage(error)}`,
      );
    }
  }

  async assembleContext(input: ProvisionRequest): Promise<ProvisionContext> {
    if (input.organizationId !== this.context.organizationId || input.userId !== this.context.userId) {
      throw new ForbiddenException('Provision request identity does not match the authenticated context');
    }
    return this.resolveContext(input);
  }

  async assembleContextForReplay(input: ProvisionRequest): Promise<ProvisionContext> {
    return this.resolveContext(input);
  }

  /** Must NOT re-run `resolveContext` — the Deployment created at request time would now trip its "no active deployment" filter. */
  async assembleContextForResume(input: ProvisionRequest): Promise<{ pubkeys: string[] }> {
    const [pubkeys, storageDrives] = await Promise.all([
      this.repo.fetchSshPublicKeys(input.sshKeyIds, input.organizationId),
      this.repo.fetchStorageDrives(input.deviceId),
    ]);
    if (pubkeys.length !== input.sshKeyIds.length) {
      throw new NotFoundException('One or more SSH keys not found');
    }
    this.provisionValidator.validateDiskGroupHomogeneity(input.diskLayouts, storageDrives);
    this.provisionValidator.validateDiskGroupSizeLimits(input.diskLayouts, storageDrives);
    return { pubkeys };
  }

  private async resolveContext(input: ProvisionRequest): Promise<ProvisionContext> {
    const { device, sshKeys, baseLayer } = await this.repo.fetchProvisionableDevice(
      input.deviceId,
      input.sshKeyIds,
      input.operatingSystemSlug,
      input.organizationId,
    );

    if (!device) throw new NotFoundException(`Device ${input.deviceId} is not available for provisioning`);
    if (sshKeys.length !== input.sshKeyIds.length) throw new NotFoundException('One or more SSH keys not found');
    if (!baseLayer) throw new NotFoundException('Selected operating system not found');
    if (baseLayer.kind !== LayerKind.BASE) {
      throw new BadRequestException(
        `Operating system ${input.operatingSystemSlug} is not installable (expected kind=BASE, got ${baseLayer.kind})`,
      );
    }
    this.provisionValidator.validateDiskGroupHomogeneity(input.diskLayouts, device.storageDrives);
    this.provisionValidator.validateDiskGroupSizeLimits(input.diskLayouts, device.storageDrives);

    return {
      baseLayerId: baseLayer.id,
      pubkeys: sshKeys.map((key) => key.key),
      supplierOrganizationId: device.supplierId ?? null,
    };
  }

  async createDeployment(input: ProvisionRequest, baseLayerId: string, reservationId: string): Promise<string> {
    const deployment = await this.deploymentsService.createDeployment({
      nickname: input.deploymentName,
      customIpxeScript: !!input.ipxeUrl,
      sshKeyIds: input.sshKeyIds,
      deviceId: input.deviceId,
      baseLayerId,
      deployerId: input.userId,
      customerId: input.organizationId,
      type: DeploymentType.SELF_SERVICE,
      reservationId,
      projectId: input.projectId,
      diskEncryptionEnabled: input.diskLayouts.some((l) => l.encrypt),
      isInterruptible: input.isInterruptible,
      interruptibleNoticePeriod: input.isInterruptible
        ? (input.interruptibleNoticePeriod ?? DEFAULT_INTERRUPTIBLE_NOTICE_MS)
        : null,
    });
    return deployment.id;
  }

  async publish(input: ProvisionRequest, deploymentId: string, pubkeys: string[], jobId: string): Promise<void> {
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
      deploymentId,
      status: 'provisioning',
    });
  }
}
