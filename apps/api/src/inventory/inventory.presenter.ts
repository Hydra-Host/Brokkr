import { DeviceStockStatusEnum, type InventoryListing, type InventoryReservationInvite } from '@repo/api-client';
import { Deployment, ReservationInvite } from '@repo/database';
import { type InviteWithOrg, ServerSpecHelper } from '@repo/device-domain';
import { type CustomizationCatalog } from '@repo/layers';
import { AuthType, IdentityContext } from 'src/auth/identity-context';
import { DeviceAggregate } from 'src/common/device.types';

export type InventoryListingContext = {
  device: DeviceAggregate;
  reservationInvites: ReservationInvite[];
  deployments: Deployment[];
  catalog?: CustomizationCatalog;
};

export class InventoryPresenter {
  static toResponse(ctx: InventoryListingContext, identity?: IdentityContext): InventoryListing {
    const { device } = ctx;
    const specs = ServerSpecHelper.specs(device);
    const hw = ServerSpecHelper.hardwareSummary(device);
    const pricing = ServerSpecHelper.pricing({
      hourlyPrice: device.server?.hourlyPrice,
      floorHourlyPrice: device.server?.floorHourlyPrice,
      gpuCount: hw.gpuCount,
      cpuPhysicalCount: hw.cpuPhysicalCount,
    });
    const activeInvite = ServerSpecHelper.activeReservationInvite(device.server?.serversInReservationInvite ?? []);

    return {
      id: device.id,
      name: device.name,
      location: ServerSpecHelper.region(device),
      role: device.role,
      stockStatus: InventoryPresenter.stockStatus(ctx),
      isTeeCapable: ServerSpecHelper.isTeeCapable(device),
      networking: {
        ipv4: ServerSpecHelper.ipv4(device),
        ipv6: ServerSpecHelper.ipv6(device),
        networkType: device.networkType,
        vpcCapable: device.server?.vpcCapable ?? false,
      },
      specs: {
        cpu: specs.cpu,
        gpu: specs.gpu,
        memory: specs.memory,
        storage: specs.storage,
      },
      listing: {
        isInterruptibleOnly: device.server?.isInterruptible ?? false,
        isActive: device.server?.isListed ?? false,
        onDemandPrice: {
          perMonth: pricing.onDemand.perMonth,
          perWeek: pricing.onDemand.perWeek,
          perHour: pricing.onDemand.perHour,
        },
        interruptiblePrice: {
          perMonth: pricing.interruptible.perMonth,
          perWeek: pricing.interruptible.perWeek,
          perHour: pricing.interruptible.perHour,
        },
      },
      // Invite emails/org must not leak to non-party or anonymous viewers on the public list.
      activeReservationInvite:
        activeInvite && identity && InventoryPresenter.reservationInviteBelongsToIdentity(ctx, identity)
          ? InventoryPresenter.serializeInvite(activeInvite, ctx, identity)
          : null,
      availableBaseLayers: ctx.catalog?.bases ?? [],
      availableComponentLayersByBase: ctx.catalog?.componentsByBase ?? {},
      storageLayouts: ServerSpecHelper.storageLayouts(device),
      defaultDiskLayouts: ServerSpecHelper.defaultDiskLayouts(device),
      isInterruptibleDeployment: InventoryPresenter.activeDeployment(ctx)?.isInterruptible ?? false,
      interruptibleNoticePeriod: InventoryPresenter.activeDeployment(ctx)?.interruptibleNoticePeriod ?? null,
      availableAt: InventoryPresenter.availableAt(),
    };
  }

  static activeDeployment(ctx: InventoryListingContext): Deployment | undefined {
    return ctx.deployments.find((deployment) => deployment.endDate === null);
  }

  static isListable(ctx: InventoryListingContext): boolean {
    const active = InventoryPresenter.activeDeployment(ctx);
    return !active || active.isInterruptible;
  }

  static stockStatus(ctx: InventoryListingContext) {
    const normalizedStatus = InventoryPresenter.normalizedStatus(ctx.device);
    const isListed = ctx.device.server?.isListed ?? false;
    const active = InventoryPresenter.activeDeployment(ctx);

    if (normalizedStatus === 'inventory' && isListed && !active) {
      return DeviceStockStatusEnum.Values['on demand'];
    }

    if (isListed && active?.isInterruptible) {
      return DeviceStockStatusEnum.Values['on demand'];
    }

    if (
      normalizedStatus === 'provisioned' ||
      normalizedStatus === 'deprovisioning' ||
      normalizedStatus === 'offline' ||
      normalizedStatus === 'provisioning' ||
      normalizedStatus === 'maintenance' ||
      !InventoryPresenter.isListable(ctx)
    ) {
      return DeviceStockStatusEnum.Values['reserve'];
    }

    return DeviceStockStatusEnum.Values['preorder'];
  }

  static availableAt(): string {
    return new Date().toISOString();
  }

  static reservationInviteBelongsToIdentity(ctx: InventoryListingContext, identity: IdentityContext): boolean {
    const invite = ServerSpecHelper.activeReservationInvite(ctx.device.server?.serversInReservationInvite ?? []);
    if (!invite) return true;
    return InventoryPresenter.inviteBelongsToIdentity(ctx, invite, identity);
  }

  /** Active invite: party check ignores listing status and plugin catalog visibility. No invite: listed AND plugin-visible. */
  static isListedOrInvitee(ctx: InventoryListingContext, identity: IdentityContext, catalogVisible = true): boolean {
    const invite = ServerSpecHelper.activeReservationInvite(ctx.device.server?.serversInReservationInvite ?? []);
    if (invite) {
      return InventoryPresenter.inviteBelongsToIdentity(ctx, invite, identity);
    }
    return catalogVisible && (ctx.device.server?.isListed ?? false);
  }

  private static identityEmail(identity: IdentityContext): string {
    switch (identity.authType) {
      case AuthType.Session:
        return identity.session.user.email;
      case AuthType.ApiKey:
        return identity.user.email;
    }
  }

  private static emailsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
    if (!left || !right) return false;
    return left.trim().toLowerCase() === right.trim().toLowerCase();
  }

  private static inviteBelongsToIdentity(
    ctx: InventoryListingContext,
    invite: ReservationInvite,
    identity: IdentityContext,
  ): boolean {
    return InventoryPresenter.isInvitee(invite, identity) || InventoryPresenter.isSupplierParty(ctx, invite, identity);
  }

  private static isInvitee(invite: ReservationInvite, identity: IdentityContext): boolean {
    return (
      invite.inviteeOrganizationId === identity.organizationId ||
      InventoryPresenter.emailsMatch(InventoryPresenter.identityEmail(identity), invite.inviteeEmail)
    );
  }

  private static isSupplierParty(
    ctx: InventoryListingContext,
    invite: ReservationInvite,
    identity: IdentityContext,
  ): boolean {
    return (
      ctx.device.supplierId === identity.organizationId ||
      InventoryPresenter.emailsMatch(InventoryPresenter.identityEmail(identity), invite.inviterEmail)
    );
  }

  // Mirrors ReservationInvitePresenter.toDeviceListingResponse redaction — buyer org is invitee-only; even the supplier who authored the invite must not learn it.
  private static serializeInvite(
    invite: InviteWithOrg,
    ctx: InventoryListingContext,
    identity: IdentityContext,
  ): InventoryReservationInvite {
    const isInvitee = InventoryPresenter.isInvitee(invite, identity);
    return {
      id: invite.id,
      inviteeEmail: invite.inviteeEmail,
      inviterEmail: invite.inviterEmail,
      inviteeOrganization:
        !isInvitee || !invite.inviteeOrganization
          ? null
          : { id: invite.inviteeOrganization.id, name: invite.inviteeOrganization.name },
      price: invite.price,
      billingFrequency: invite.billingFrequency,
      dateCreated: invite.dateCreated.toISOString(),
      dateExpires: invite.dateExpires.toISOString(),
      interruptibleNoticePeriod: invite.interruptibleNoticePeriod,
    };
  }

  private static normalizedStatus(device: DeviceAggregate): string {
    return device.server?.lifecycleStatus?.toLowerCase();
  }
}
