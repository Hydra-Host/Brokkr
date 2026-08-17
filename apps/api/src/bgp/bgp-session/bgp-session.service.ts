import { Injectable } from '@nestjs/common';
import { BgpSessionPresenter } from './bgp-session.presenter';
import {
  BgpSessionListQuery,
  BgpSessionRecord,
  CreateBgpSessionInput,
  UpdateBgpSessionInput,
} from './bgp-session.record';

@Injectable()
export class BgpSessionService {
  async list(query: BgpSessionListQuery) {
    const records = await BgpSessionRecord.list(query);
    return records.map((r) => BgpSessionPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await BgpSessionRecord.findByIdOrThrow(id);
    return BgpSessionPresenter.toResponse(record);
  }

  async create(input: CreateBgpSessionInput) {
    const record = await BgpSessionRecord.create(input);
    return BgpSessionPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateBgpSessionInput) {
    const record = await BgpSessionRecord.updateById(id, input);
    return BgpSessionPresenter.toResponse(record);
  }

  async delete(id: string) {
    await BgpSessionRecord.deleteById(id);
  }
}
