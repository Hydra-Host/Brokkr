import { Injectable } from '@nestjs/common';
import type { Pdu, PduListResponse, PdusQuery, UpdatePduRequest } from '@repo/api-client';
import { PduPresenter } from './pdu.presenter';
import { PduRecord } from './pdu.record';

@Injectable()
export class PduService {
  async list(query: PdusQuery): Promise<PduListResponse> {
    const result = await PduRecord.listPaginated(query);
    return { data: result.data.map((d) => PduPresenter.toResponse(d)), meta: result.meta };
  }

  async findByDeviceId(deviceId: string): Promise<Pdu> {
    const record = await PduRecord.findByDeviceIdOrThrow(deviceId, { includeDeleted: true });
    return PduPresenter.toResponse(record.data);
  }

  async update(deviceId: string, body: UpdatePduRequest): Promise<Pdu> {
    const record = await PduRecord.updateByDeviceId(deviceId, body);
    return PduPresenter.toResponse(record.data);
  }

  async decommission(deviceId: string): Promise<void> {
    await PduRecord.decommissionByDeviceId(deviceId);
  }
}
