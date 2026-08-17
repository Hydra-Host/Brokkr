import { Injectable } from '@nestjs/common';
import { CircuitPresenter } from './circuit.presenter';
import { CircuitListQuery, CircuitRecord, CreateCircuitInput, UpdateCircuitInput } from './circuit.record';

@Injectable()
export class CircuitService {
  async list(query: CircuitListQuery) {
    const records = await CircuitRecord.list(query);
    return records.map((r) => CircuitPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await CircuitRecord.findByIdOrThrow(id);
    return CircuitPresenter.toResponse(record);
  }

  async create(input: CreateCircuitInput) {
    const record = await CircuitRecord.create(input);
    return CircuitPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateCircuitInput) {
    const record = await CircuitRecord.updateById(id, input);
    return CircuitPresenter.toResponse(record);
  }

  async delete(id: string) {
    await CircuitRecord.deleteById(id);
  }
}
