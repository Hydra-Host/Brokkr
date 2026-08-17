import { Injectable } from '@nestjs/common';
import { PrefixListPresenter } from './prefix-list.presenter';
import { CreatePrefixListInput, PrefixListRecord, UpdatePrefixListInput } from './prefix-list.record';

@Injectable()
export class PrefixListService {
  async list(filters?: { family?: string; search?: string }) {
    const records = await PrefixListRecord.list(filters);
    return records.map((r) => PrefixListPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await PrefixListRecord.findByIdOrThrow(id);
    return PrefixListPresenter.toResponse(record);
  }

  async create(input: CreatePrefixListInput) {
    const record = await PrefixListRecord.create(input);
    return PrefixListPresenter.toResponse(record);
  }

  async update(id: string, input: UpdatePrefixListInput) {
    const record = await PrefixListRecord.updateById(id, input);
    return PrefixListPresenter.toResponse(record);
  }

  async delete(id: string) {
    await PrefixListRecord.deleteById(id);
  }
}
