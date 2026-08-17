import { Injectable } from '@nestjs/common';
import { CircuitTerminationPresenter } from './circuit-termination.presenter';
import {
  CircuitTerminationListQuery,
  CircuitTerminationRecord,
  CreateCircuitTerminationInput,
  UpdateCircuitTerminationInput,
} from './circuit-termination.record';

@Injectable()
export class CircuitTerminationService {
  async list(query: CircuitTerminationListQuery) {
    const records = await CircuitTerminationRecord.list(query);
    return records.map((r) => CircuitTerminationPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await CircuitTerminationRecord.findByIdOrThrow(id);
    return CircuitTerminationPresenter.toResponse(record);
  }

  async create(input: CreateCircuitTerminationInput) {
    const record = await CircuitTerminationRecord.create(input);
    return CircuitTerminationPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateCircuitTerminationInput) {
    const record = await CircuitTerminationRecord.updateById(id, input);
    return CircuitTerminationPresenter.toResponse(record);
  }

  async delete(id: string) {
    await CircuitTerminationRecord.deleteById(id);
  }
}
