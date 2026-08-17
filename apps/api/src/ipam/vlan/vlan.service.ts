import { Injectable } from '@nestjs/common';
import { CreateVlanRequest, UpdateVlanRequest, Vlan, VlanListQuery } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { VlanEntity } from './vlan.entity';
import { VlanRepository } from './vlan.repository';

@Injectable()
export class VlanService {
  constructor(
    private readonly vlanRepository: VlanRepository,
    private readonly contextService: ContextService,
  ) {}

  async findById(id: string): Promise<Vlan> {
    this.contextService.requirePermission('ipam', 'read');
    return this.vlanRepository.restore(id);
  }

  async listVlans(query: VlanListQuery): Promise<Vlan[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.vlanRepository.listVlans(query);
  }

  async createVlan(input: CreateVlanRequest): Promise<Vlan> {
    this.contextService.requirePermission('ipam', 'create');
    const entity = VlanEntity.create(input, this.contextService.organizationId);
    this.vlanRepository.ensureValidVid(entity.state.vid);
    await this.vlanRepository.ensureVrf(entity);
    return this.vlanRepository.createWithConflictGuard(entity);
  }

  async updateVlan(id: string, input: UpdateVlanRequest): Promise<Vlan> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.vlanRepository.restore(id);
    const entity = VlanEntity.restore(before);
    entity.applyUpdate(input);
    if (input.vid !== undefined) {
      this.vlanRepository.ensureValidVid(entity.state.vid);
    }
    await this.vlanRepository.ensureVrf(entity);
    return this.vlanRepository.updateWithConflictGuard(entity, before);
  }

  async archiveVlan(id: string): Promise<Vlan> {
    this.contextService.requirePermission('ipam', 'delete');
    const before = await this.vlanRepository.restore(id);
    const entity = VlanEntity.restore(before);
    entity.archive();
    return this.vlanRepository.save(entity, before);
  }
}
