import { Injectable } from '@nestjs/common';
import { PrefixListRulePresenter } from './prefix-list-rule.presenter';
import {
  CreatePrefixListRuleInput,
  PrefixListRuleListQuery,
  PrefixListRuleRecord,
  UpdatePrefixListRuleInput,
} from './prefix-list-rule.record';

@Injectable()
export class PrefixListRuleService {
  async list(query: PrefixListRuleListQuery) {
    const records = await PrefixListRuleRecord.list(query);
    return records.map((r) => PrefixListRulePresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await PrefixListRuleRecord.findByIdOrThrow(id);
    return PrefixListRulePresenter.toResponse(record);
  }

  async create(input: CreatePrefixListRuleInput) {
    const record = await PrefixListRuleRecord.create(input);
    return PrefixListRulePresenter.toResponse(record);
  }

  async update(id: string, input: UpdatePrefixListRuleInput) {
    const record = await PrefixListRuleRecord.updateById(id, input);
    return PrefixListRulePresenter.toResponse(record);
  }

  async delete(id: string) {
    await PrefixListRuleRecord.deleteById(id);
  }
}
