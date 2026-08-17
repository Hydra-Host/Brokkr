import type { CircuitRecord } from './circuit.record';

export class CircuitPresenter {
  static toResponse(record: CircuitRecord) {
    const data = record.data;
    return {
      id: data.id,
      cid: data.cid,
      status: data.status,
      installDate: data.installDate,
      terminationDate: data.terminationDate,
      commitRate: data.commitRate,
      description: data.description,
      comments: data.comments,
      providerId: data.providerId,
      circuitTypeId: data.circuitTypeId,
      organizationId: data.organizationId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
