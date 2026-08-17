import { Injectable } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { ProviderNetworkPresenter } from './provider-network.presenter';
import {
  CreateProviderNetworkInput,
  ProviderNetworkRecord,
  UpdateProviderNetworkInput,
} from './provider-network.record';

@Injectable()
export class ProviderNetworkService {
  constructor(private readonly contextService: ContextService) {}

  async list(filters?: { providerId?: string; search?: string }) {
    const records = await ProviderNetworkRecord.list(filters);
    return records.map((r) => ProviderNetworkPresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await ProviderNetworkRecord.findByIdOrThrow(id);
    return ProviderNetworkPresenter.toResponse(record);
  }

  async create(input: CreateProviderNetworkInput) {
    this.contextService.requireInstanceOperator();
    const record = await ProviderNetworkRecord.createOne(input);
    return ProviderNetworkPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateProviderNetworkInput) {
    this.contextService.requireInstanceOperator();
    const record = await ProviderNetworkRecord.updateById(id, input);
    return ProviderNetworkPresenter.toResponse(record);
  }

  async delete(id: string) {
    this.contextService.requireInstanceOperator();
    await ProviderNetworkRecord.deleteById(id);
  }
}
