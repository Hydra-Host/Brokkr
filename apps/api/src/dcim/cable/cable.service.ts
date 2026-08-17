import { Injectable } from '@nestjs/common';
import type { DcimCable, DcimCableListQuery, DcimCableListResponse } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { CablePresenter } from './cable.presenter';
import { CableRecord, CreateCableInput, UpdateCableInput } from './cable.record';

@Injectable()
export class CableService {
  constructor(private readonly contextService: ContextService) {}

  private get supplierId(): string {
    return this.contextService.organizationId;
  }

  async list(query: DcimCableListQuery): Promise<DcimCableListResponse> {
    const result = await CableRecord.listPaginated(query, this.supplierId);
    return {
      ...result,
      data: result.data.map((c) => CablePresenter.toResponse(c)),
    };
  }

  async findById(id: string): Promise<DcimCable> {
    const cable = await CableRecord.findByIdOrThrow(id, this.supplierId);
    return CablePresenter.toResponse(cable);
  }

  async create(input: CreateCableInput): Promise<DcimCable> {
    const cable = await CableRecord.createWithTerminations(input, this.supplierId);
    return CablePresenter.toResponse(cable);
  }

  async update(id: string, input: UpdateCableInput): Promise<DcimCable> {
    const cable = await CableRecord.updateById(id, input, this.supplierId);
    return CablePresenter.toResponse(cable);
  }

  async delete(id: string) {
    await CableRecord.deleteById(id, this.supplierId);
  }
}
