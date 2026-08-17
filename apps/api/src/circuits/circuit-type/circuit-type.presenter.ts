import type { CircuitTypeRecord } from './circuit-type.record';

export class CircuitTypePresenter {
  static toResponse(record: CircuitTypeRecord) {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      color: data.color,
      description: data.description,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
