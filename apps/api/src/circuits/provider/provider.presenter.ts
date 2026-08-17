import type { ProviderRecord } from './provider.record';

export class ProviderPresenter {
  static toResponse(record: ProviderRecord) {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description,
      comments: data.comments,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
