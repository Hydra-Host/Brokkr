import { Injectable } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { ProviderPresenter } from './provider.presenter';
import { CreateProviderInput, ProviderRecord, UpdateProviderInput } from './provider.record';

@Injectable()
export class ProviderService {
  constructor(private readonly contextService: ContextService) {}

  async list(search?: string) {
    const records = await ProviderRecord.list(search);
    return records.map((r) => ProviderPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await ProviderRecord.findByIdOrThrow(id);
    return ProviderPresenter.toResponse(record);
  }

  async create(input: CreateProviderInput) {
    this.contextService.requireInstanceOperator();
    const record = await ProviderRecord.createOne(input);
    return ProviderPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateProviderInput) {
    this.contextService.requireInstanceOperator();
    const record = await ProviderRecord.updateById(id, input);
    return ProviderPresenter.toResponse(record);
  }

  async delete(id: string) {
    this.contextService.requireInstanceOperator();
    await ProviderRecord.deleteById(id);
  }
}
