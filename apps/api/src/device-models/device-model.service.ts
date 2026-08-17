import { Injectable } from '@nestjs/common';
import { CreateDeviceModelRequest, UpdateDeviceModelRequest } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { DeviceModelRepository } from './device-model.repository';

@Injectable()
export class DeviceModelService {
  constructor(
    private readonly repo: DeviceModelRepository,
    private readonly contextService: ContextService,
  ) {}

  async list(manufacturer?: string) {
    this.contextService.requirePermission('device-model', 'read');
    return this.repo.list(manufacturer);
  }

  async findById(id: string) {
    this.contextService.requirePermission('device-model', 'read');
    return this.repo.findById(id);
  }

  async create(input: CreateDeviceModelRequest) {
    this.contextService.requirePermission('device-model', 'create');
    return this.repo.create(input);
  }

  async update(id: string, input: UpdateDeviceModelRequest) {
    this.contextService.requirePermission('device-model', 'update');
    return this.repo.update(id, input);
  }

  async delete(id: string) {
    this.contextService.requirePermission('device-model', 'delete');
    return this.repo.delete(id);
  }
}
