import type { CircuitTerminationRecord } from './circuit-termination.record';

export class CircuitTerminationPresenter {
  static toResponse(record: CircuitTerminationRecord) {
    const data = record.data;
    return {
      id: data.id,
      termSide: data.termSide,
      portSpeed: data.portSpeed,
      upstreamSpeed: data.upstreamSpeed,
      xconnectId: data.xconnectId,
      description: data.description,
      circuitId: data.circuitId,
      zoneId: data.zoneId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
