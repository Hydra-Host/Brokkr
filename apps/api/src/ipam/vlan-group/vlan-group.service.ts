import { Injectable } from '@nestjs/common';
import { CreateVlanGroupRequest, UpdateVlanGroupRequest } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { VlanGroupRepository } from './vlan-group.repository';

@Injectable()
export class VlanGroupService {
  constructor(
    private readonly contextService: ContextService,
    private readonly repo: VlanGroupRepository,
  ) {}

  private get organizationId(): string {
    return this.contextService.organizationId;
  }

  async list(query: { zoneId?: string }) {
    this.contextService.requirePermission('ipam', 'read');
    return this.repo.list(query, this.organizationId);
  }

  async findById(id: string) {
    this.contextService.requirePermission('ipam', 'read');
    return this.repo.findById(id, this.organizationId);
  }

  async create(input: CreateVlanGroupRequest) {
    this.contextService.requirePermission('ipam', 'create');
    return this.repo.create(input, this.organizationId);
  }

  async update(id: string, input: UpdateVlanGroupRequest) {
    this.contextService.requirePermission('ipam', 'update');
    return this.repo.update(id, input, this.organizationId);
  }

  async delete(id: string) {
    this.contextService.requirePermission('ipam', 'delete');
    return this.repo.delete(id, this.organizationId);
  }
}
