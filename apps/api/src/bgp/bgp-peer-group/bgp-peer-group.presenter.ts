import type { BgpPeerGroupRecord } from './bgp-peer-group.record';

export class BgpPeerGroupPresenter {
  static toResponse(record: BgpPeerGroupRecord) {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      description: data.description,
      organizationId: data.organizationId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
