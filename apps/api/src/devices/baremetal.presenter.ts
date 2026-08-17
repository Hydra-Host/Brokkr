import type { Server } from '@repo/api-client';
import { serverPowerStatusToLegacy, ServerSpecHelper } from '@repo/device-domain';
import { type CustomizationCatalog } from '@repo/layers';
import { capitalizeFirstLetter } from '@repo/utils';
import { DeviceAggregate } from 'src/common/device.types';
import { toInterfaceResponse } from 'src/common/interface-response.utils';

export class BaremetalPresenter {
  static toResponse(device: DeviceAggregate, catalog?: CustomizationCatalog): Server {
    const activeDeployment = ServerSpecHelper.activeDeployment(device.server?.deployments ?? []);
    const activeInvite = ServerSpecHelper.activeReservationInvite(device.server?.serversInReservationInvite ?? []);
    const reservationType = ServerSpecHelper.reservationType(activeDeployment, activeInvite, device.role);
    const status = ServerSpecHelper.status(device, activeDeployment);
    const specs = ServerSpecHelper.specs(device);
    const hw = ServerSpecHelper.hardwareSummary(device);
    const pricing = ServerSpecHelper.pricing({
      hourlyPrice: device.server?.hourlyPrice,
      floorHourlyPrice: device.server?.floorHourlyPrice,
      gpuCount: hw.gpuCount,
      cpuPhysicalCount: hw.cpuPhysicalCount,
    });
    const reservationData = ServerSpecHelper.reservationData(activeDeployment, hw.gpuCount);
    const power = serverPowerStatusToLegacy(device.server?.powerStatus ?? null) ?? 'Unknown';

    const inviteData = ServerSpecHelper.reservationInviteData(activeInvite, hw.gpuCount);

    return {
      id: device.id,
      name: device.name,
      role: device.role,
      deletedAt: device.deletedAt?.toISOString() ?? null,
      zoneName: ServerSpecHelper.zoneName(device),
      status: {
        value: status,
        label: capitalizeFirstLetter(status),
      },
      powerStatus: {
        value: power,
        label: power,
      },
      customer: {
        deviceName: activeDeployment?.nickname ?? null,
        organizationId: null,
        provisionedDate: activeDeployment?.startDate.toISOString() ?? null,
        sshPubKeys: null,
        sshPubKeysIds: null,
        userId: null,
        reservationType,
      },
      dcim: {
        nickname: device.nickname,
      },
      listing: {
        isInterruptibleOnly: device.server?.isInterruptible ?? false,
        isActive: device.server?.isListed ?? false,
        isPrivate: null,
        invitee: null,
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
      networking: {
        downloadSpeed: null,
        ipv4: ServerSpecHelper.ipv4(device),
        ipv6: ServerSpecHelper.ipv6(device),
        mac: ServerSpecHelper.mac(device),
        uploadSpeed: null,
        ipmiIp: ServerSpecHelper.ipmiIp(device),
        vpcCapable: device.server?.vpcCapable ?? false,
      },
      interfaces: (device.interfaces ?? []).map(toInterfaceResponse),
      specs: {
        cpu: specs.cpu,
        gpu: specs.gpu,
        memory: specs.memory,
        storage: specs.storage,
      },
      tenant: {
        name: device.supplier.name,
        slug: device.supplier.id,
        id: device.supplier.id,
      },
      availableBaseLayers: catalog?.bases ?? [],
      availableComponentLayersByBase: catalog?.componentsByBase ?? {},
      storageLayouts: ServerSpecHelper.storageLayouts(device),
      defaultDiskLayouts: ServerSpecHelper.defaultDiskLayouts(device),
      deployment: activeDeployment
        ? {
            deployerEmail: activeDeployment.deployer?.email ?? null,
            reservation: reservationData
              ? {
                  price: reservationData.price,
                  pricePerGpuHour: reservationData.pricePerGpuHour,
                  pricePerDeviceHour: reservationData.pricePerDeviceHour,
                  billingFrequency: reservationData.billingFrequency,
                }
              : null,
          }
        : null,
      reservationInvite: inviteData
        ? {
            id: inviteData.id,
            inviteeEmail: inviteData.inviteeEmail,
            price: inviteData.price,
            pricePerGpuHour: inviteData.pricePerGpuHour,
            pricePerDeviceHour: inviteData.pricePerDeviceHour,
            billingFrequency: inviteData.billingFrequency,
            dateCreated: inviteData.dateCreated,
            dateExpires: inviteData.dateExpires,
            dateAccepted: inviteData.dateAccepted,
            dateDeleted: inviteData.dateDeleted,
            interruptibleNoticePeriod: inviteData.interruptibleNoticePeriod,
          }
        : null,
      ecoMode: device.server.ecoMode ?? false,
      ipxeBuildTarget: device.ipxeBuildTarget ?? null,
      isTeeCapable: ServerSpecHelper.isTeeCapable(device),
      isHealthy: ServerSpecHelper.isHealthy(device),
    };
  }
}
