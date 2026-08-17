import type { PrefixListRecord } from './prefix-list.record';

export class PrefixListPresenter {
  static toResponse(record: PrefixListRecord) {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      description: data.description,
      family: data.family,
      organizationId: data.organizationId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
