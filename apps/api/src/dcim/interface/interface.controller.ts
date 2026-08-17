import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { InterfaceService } from './interface.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class InterfaceController {
  constructor(private readonly service: InterfaceService) {}

  @TsRestHandler(contract.listDcimInterfaces)
  async list() {
    return tsRestHandler(contract.listDcimInterfaces, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimInterface)
  async getById() {
    return tsRestHandler(contract.getDcimInterface, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimInterface)
  async create() {
    return tsRestHandler(contract.createDcimInterface, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type,
        enabled: body.enabled,
        mtu: body.mtu,
        macAddress: body.macAddress,
        speed: body.speed,
        mgmtOnly: body.mgmtOnly,
        markConnected: body.markConnected,
        mode: body.mode,
        description: body.description,
        linkType: body.linkType,
        guid: body.guid,
        portState: body.portState,
        maxSpeedGbps: body.maxSpeedGbps,
        pciDeviceId: body.pciDeviceId,
        lldpNeighborName: body.lldpNeighborName,
        lldpNeighborPort: body.lldpNeighborPort,
        lldpNeighborDescr: body.lldpNeighborDescr,
        lldpNeighborMgmtIp: body.lldpNeighborMgmtIp,
        lagId: body.lagId,
        parentId: body.parentId,
        untaggedVlanId: body.untaggedVlanId,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimInterface)
  async update() {
    return tsRestHandler(contract.updateDcimInterface, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimInterface)
  async delete() {
    return tsRestHandler(contract.deleteDcimInterface, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }

  @TsRestHandler(contract.listDeviceInterfaces)
  async listForDevice() {
    return tsRestHandler(contract.listDeviceInterfaces, async ({ params }) => ({
      status: 200,
      body: await this.service.listForDevice(params.deviceId),
    }));
  }

  @TsRestHandler(contract.bulkUpdateDeviceInterfaces)
  async bulkUpdate() {
    return tsRestHandler(contract.bulkUpdateDeviceInterfaces, async ({ params, body }) => {
      await this.service.bulkApply(params.deviceId, body);
      return { status: 204 as const, body: undefined };
    });
  }
}
