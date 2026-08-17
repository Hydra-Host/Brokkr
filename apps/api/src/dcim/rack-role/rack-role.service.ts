import { Injectable } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { RackRolePresenter } from './rack-role.presenter';
import { CreateRackRoleInput, RackRoleRecord, UpdateRackRoleInput } from './rack-role.record';

@Injectable()
export class RackRoleService {
  constructor(private readonly contextService: ContextService) {}

  async list(search?: string) {
    const records = await RackRoleRecord.list(search);
    return records.map((r) => RackRolePresenter.toResponse(r));
  }

  async findById(id: string) {
    const record = await RackRoleRecord.findByIdOrThrow(id);
    return RackRolePresenter.toResponse(record);
  }

  async create(input: CreateRackRoleInput) {
    this.contextService.requireInstanceOperator();
    const record = await RackRoleRecord.createRole(input);
    return RackRolePresenter.toResponse(record);
  }

  async update(id: string, input: UpdateRackRoleInput) {
    this.contextService.requireInstanceOperator();
    const record = await RackRoleRecord.updateById(id, input);
    return RackRolePresenter.toResponse(record);
  }

  async delete(id: string) {
    this.contextService.requireInstanceOperator();
    await RackRoleRecord.deleteById(id);
  }
}
