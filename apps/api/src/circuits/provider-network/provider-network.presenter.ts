import type { ProviderNetworkRecord } from './provider-network.record';

export class ProviderNetworkPresenter {
  static toResponse(record: ProviderNetworkRecord) {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      description: data.description,
      comments: data.comments,
      providerId: data.providerId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
