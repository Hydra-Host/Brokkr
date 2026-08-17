import type { PrefixListRuleRecord } from './prefix-list-rule.record';

export class PrefixListRulePresenter {
  static toResponse(record: PrefixListRuleRecord) {
    const data = record.data;
    return {
      id: data.id,
      action: data.action,
      prefix: data.prefix,
      ge: data.ge,
      le: data.le,
      sequence: data.sequence,
      prefixListId: data.prefixListId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
