import { Injectable } from '@nestjs/common';
import { BgpPeerGroupPresenter } from './bgp-peer-group.presenter';
import { BgpPeerGroupRecord, CreateBgpPeerGroupInput, UpdateBgpPeerGroupInput } from './bgp-peer-group.record';

@Injectable()
export class BgpPeerGroupService {
  async list(search?: string) {
    const records = await BgpPeerGroupRecord.list(search);
    return records.map((r) => BgpPeerGroupPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await BgpPeerGroupRecord.findByIdOrThrow(id);
    return BgpPeerGroupPresenter.toResponse(record);
  }

  async create(input: CreateBgpPeerGroupInput) {
    const record = await BgpPeerGroupRecord.create(input);
    return BgpPeerGroupPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateBgpPeerGroupInput) {
    const record = await BgpPeerGroupRecord.updateById(id, input);
    return BgpPeerGroupPresenter.toResponse(record);
  }

  async delete(id: string) {
    await BgpPeerGroupRecord.deleteById(id);
  }
}
