import { Injectable } from '@nestjs/common';
import type {
  BulkUpdateDeviceInterfacesRequest,
  DcimInterface,
  DcimInterfaceListQuery,
  DcimInterfaceListResponse,
  DeviceInterfaceWithIps,
} from '@repo/api-client';
import { NetplanLiveInvalidatorService } from 'src/brokkr-bridge/netplan/netplan-live-invalidator.service';
import { InterfacePresenter } from './interface.presenter';
import { CreateInterfaceInput, InterfaceRecord, UpdateInterfaceInput } from './interface.record';

@Injectable()
export class InterfaceService {
  constructor(private readonly netplanLive: NetplanLiveInvalidatorService) {}

  async list(query: DcimInterfaceListQuery): Promise<DcimInterfaceListResponse> {
    const result = await InterfaceRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => InterfacePresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimInterface> {
    const record = await InterfaceRecord.findByIdOrThrow(id);
    return InterfacePresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreateInterfaceInput): Promise<DcimInterface> {
    const record = await InterfaceRecord.createForDevice(deviceId, input);
    await this.netplanLive.forDevice(deviceId);
    return InterfacePresenter.toResponse(record);
  }

  async update(id: string, input: UpdateInterfaceInput): Promise<DcimInterface> {
    const record = await InterfaceRecord.updateById(id, input);
    await this.netplanLive.forDevice(record.data.deviceId);
    return InterfacePresenter.toResponse(record);
  }

  async delete(id: string) {
    const { deviceId } = await InterfaceRecord.deleteById(id);
    await this.netplanLive.forDevice(deviceId);
  }

  async listForDevice(deviceId: string): Promise<DeviceInterfaceWithIps[]> {
    const rows = await InterfaceRecord.listForDeviceWithIps(deviceId);
    return rows.map((r) => InterfacePresenter.toResponseWithIps(r));
  }

  async bulkApply(deviceId: string, input: BulkUpdateDeviceInterfacesRequest): Promise<void> {
    await InterfaceRecord.bulkApplyForDevice(deviceId, {
      deletes: input.deletes,
      updates: input.updates.map(({ id, ...data }) => ({ id, data })),
      creates: input.creates,
    });
    await this.netplanLive.forDevice(deviceId);
  }
}
