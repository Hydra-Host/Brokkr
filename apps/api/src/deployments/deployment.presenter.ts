import { HttpException, HttpStatus } from '@nestjs/common';
import type { Deployment as DeploymentResponse } from '@repo/api-client';
import {
  AdminLifecycleRequest,
  AdminLifecycleRequestStatus,
  AdminLifecycleRequestType,
  DeploymentLifecycleActionType,
  User,
} from '@repo/database';
import { serverPowerStatusToLegacy, ServerSpecHelper } from '@repo/device-domain';
import { type CustomizationCatalog } from '@repo/layers';
import { capitalizeFirstLetter, mapStatusToDeploymentStatus } from '@repo/utils';
import { toJsonRecord } from 'src/common/json-utils';
import { RESCUE_OS_SLUG } from 'src/provision/provision.types';
import type { DeploymentAggregate } from './types/deployments.types';

export class DeploymentPresenter {
  static toResponse(aggregate: DeploymentAggregate, catalog?: CustomizationCatalog): DeploymentResponse {
    const device = {
      ...aggregate.server.device,
      server: aggregate.server,
    };
    const sshKeys = aggregate.deploymentKeys.map((key) => ({
      ...key.sshKey,
      user: { firstName: key.sshKey.user.firstName, lastName: key.sshKey.user.lastName },
    }));
    const status = this.resolveStatus(aggregate);
    const specs = ServerSpecHelper.specs(device);
    const power = serverPowerStatusToLegacy(aggregate.server.powerStatus ?? null) ?? 'Unknown';

    return {
      id: aggregate.id,
      location: ServerSpecHelper.region(device),
      status: {
        value: status,
        label: this.statusLabel(status),
      },
      powerStatus: {
        value: power,
        label: power,
      },
      scheduledInterruptionTime: aggregate.scheduledInterruptionTime?.toISOString() ?? null,
      tags: [],
      role: { slug: device.role ?? '' },
      customer: {
        deviceName: aggregate.nickname,
        organizationId: aggregate.customerId,
        provisionedDate: aggregate.createdAt.toISOString(),
        sshPubKeys: sshKeys.map((k) => k.key).join(','),
        sshPubKeysIds: sshKeys.map((k) => k.id).join(','),
        userId: aggregate.deployer.id,
      },
      networking: {
        ipv4: ServerSpecHelper.ipv4(device),
        ipv6: ServerSpecHelper.ipv6(device),
        mac: ServerSpecHelper.mac(device),
      },
      sshKeys,
      specs: {
        operating_system: aggregate.baseLayer?.name,
        current_rescue_operating_system_name:
          aggregate.rescueLayer?.slug === RESCUE_OS_SLUG ? aggregate.rescueLayer.name : undefined,
        cpu: specs.cpu,
        gpu: specs.gpu,
        memory: specs.memory,
        storage: specs.storage,
      },
      availableBaseLayers: catalog?.bases ?? [],
      availableComponentLayersByBase: catalog?.componentsByBase ?? {},
      storageLayouts: ServerSpecHelper.storageLayouts(device) as DeploymentResponse['storageLayouts'],
      defaultDiskLayouts: ServerSpecHelper.defaultDiskLayouts(device),
      isLocked: aggregate.isLocked,
      isTeeCapable: ServerSpecHelper.isTeeCapable(device),
      teeEnabled: ServerSpecHelper.teeEnabled(device),
      lifecycleActions: aggregate.lifecycleActions.map((action) => ({
        id: action.id,
        actionType: action.actionType,
        performedByName: `${action.user?.firstName ?? ''} ${action.user?.lastName ?? ''}`.trim(),
        performedByEmail: action.user?.email ?? '',
        performedAt: action.performedAt.toISOString(),
        source: action.source,
      })),
      lifecycleRequests: this.lifecycleRequestsToJSON(aggregate),
      project: {
        id: aggregate.deploymentProject.id,
        name: aggregate.deploymentProject.name,
        isDefault: aggregate.deploymentProject.isDefault,
        createdAt: aggregate.deploymentProject.createdAt.toISOString(),
        updatedAt: aggregate.deploymentProject.updatedAt?.toISOString() ?? null,
      },
      deviceDiagnostics: (aggregate.deviceDiagnostics ?? []).map((d) => ({
        id: d.id,
        type: d.type,
        data: d.data as Record<string, unknown> | null,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  private static statusLabel(status: string): string {
    if (status === 'awaiting_approval') return 'Awaiting approval';
    return capitalizeFirstLetter(status);
  }

  // Rescue is settled-state only: mid-lifecycle it would clobber the transient brokkr-discovery boot override and derail the saga.
  static readonly RESCUE_ELIGIBLE_STATUSES = ['provisioned', 'failed'] as const;

  static isRescueModeEligible(aggregate: DeploymentAggregate): boolean {
    const eligible: readonly string[] = DeploymentPresenter.RESCUE_ELIGIBLE_STATUSES;
    return eligible.includes(this.resolveStatus(aggregate));
  }

  private static resolveStatus(aggregate: DeploymentAggregate): string {
    if (aggregate.lifecycleJobs.length > 0) return 'awaiting_approval';

    const rawStatus = (aggregate.server.lifecycleStatus ?? aggregate.server.device.status ?? '').toString();
    const deviceStatus = rawStatus.toLowerCase();
    // Must use server.updatedAt, not device's: phone-home bumps only the Server row, so the device timestamp would leave a provisioned box stuck showing "queued".
    const statusUpdatedAt = aggregate.server.updatedAt;

    const latestProvisionAction = aggregate.lifecycleActions
      .filter(
        (action) =>
          action.actionType === DeploymentLifecycleActionType.Provision ||
          action.actionType === DeploymentLifecycleActionType.Reprovision,
      )
      .sort((a, b) => b.performedAt.getTime() - a.performedAt.getTime())[0];

    if (
      latestProvisionAction &&
      deviceStatus === 'provisioned' &&
      statusUpdatedAt < latestProvisionAction.performedAt
    ) {
      return 'queued';
    }

    return mapStatusToDeploymentStatus(deviceStatus);
  }

  static lifecycleRequestsToJSON(aggregate: DeploymentAggregate) {
    const ownerOrgId = aggregate.customerId;
    return aggregate.lifecycleRequests
      .filter((r) => {
        const body = toJsonRecord(r.requestBody);
        return typeof body.organizationId !== 'string' || body.organizationId === ownerOrgId;
      })
      .map((r) => ({
        id: r.id,
        deploymentId: r.deploymentId,
        type: r.type,
        status: r.status,
        requestBody: toJsonRecord(r.requestBody),
        requestedByName: r.requestedBy.name,
        approvedAt: r.approvedAt?.toISOString() ?? null,
        rejectedAt: r.rejectedAt?.toISOString() ?? null,
        executedAt: r.executedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  static findLifecycleRequestById(
    aggregate: DeploymentAggregate,
    requestId: string,
  ): (AdminLifecycleRequest & { requestedBy: User }) | null {
    const ownerOrgId = aggregate.customerId;
    return (
      aggregate.lifecycleRequests.find((r) => {
        if (r.id !== requestId) return false;
        const body = toJsonRecord(r.requestBody);
        return typeof body.organizationId !== 'string' || body.organizationId === ownerOrgId;
      }) ?? null
    );
  }

  static getApprovedLifecycleRequestOrThrow(
    aggregate: DeploymentAggregate,
    type: AdminLifecycleRequestType,
  ): AdminLifecycleRequest & { requestedBy: User } {
    const approved = aggregate.lifecycleRequests
      .filter((r) => r.type === type && r.status === AdminLifecycleRequestStatus.APPROVED)
      .sort((a, b) => (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0));

    if (approved.length === 0) {
      throw new HttpException(
        `${type} requires customer approval. Create a lifecycle request first.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return approved[0];
  }

  static extractSshKeys(aggregate: DeploymentAggregate) {
    return aggregate.deploymentKeys.map((key) => ({
      ...key.sshKey,
      user: { firstName: key.sshKey.user.firstName, lastName: key.sshKey.user.lastName },
    }));
  }
}
