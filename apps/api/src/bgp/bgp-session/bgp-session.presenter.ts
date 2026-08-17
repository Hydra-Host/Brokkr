import type { BgpSessionRecord } from './bgp-session.record';

export class BgpSessionPresenter {
  static toResponse(record: BgpSessionRecord) {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      status: data.status,
      description: data.description,
      deviceId: data.deviceId,
      localAsnId: data.localAsnId,
      remoteAsnId: data.remoteAsnId,
      localAddressId: data.localAddressId,
      remoteAddressId: data.remoteAddressId,
      peerGroupId: data.peerGroupId,
      prefixListInId: data.prefixListInId,
      prefixListOutId: data.prefixListOutId,
      organizationId: data.organizationId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
