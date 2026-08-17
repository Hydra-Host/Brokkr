import { Injectable } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { CircuitTypePresenter } from './circuit-type.presenter';
import { CircuitTypeRecord, CreateCircuitTypeInput, UpdateCircuitTypeInput } from './circuit-type.record';

@Injectable()
export class CircuitTypeService {
  constructor(private readonly contextService: ContextService) {}

  async list(search?: string) {
    const records = await CircuitTypeRecord.list(search);
    return records.map((r) => CircuitTypePresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await CircuitTypeRecord.findByIdOrThrow(id);
    return CircuitTypePresenter.toResponse(record);
  }

  async create(input: CreateCircuitTypeInput) {
    this.contextService.requireInstanceOperator();
    const record = await CircuitTypeRecord.createOne(input);
    return CircuitTypePresenter.toResponse(record);
  }

  async update(id: string, input: UpdateCircuitTypeInput) {
    this.contextService.requireInstanceOperator();
    const record = await CircuitTypeRecord.updateById(id, input);
    return CircuitTypePresenter.toResponse(record);
  }

  async delete(id: string) {
    this.contextService.requireInstanceOperator();
    await CircuitTypeRecord.deleteById(id);
  }
}
