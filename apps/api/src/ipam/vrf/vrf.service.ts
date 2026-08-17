import { Injectable } from '@nestjs/common';
import { CreateVrfRequest, UpdateVrfRequest, Vrf, VrfListQuery } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { VrfEntity } from './vrf.entity';
import { VrfRepository } from './vrf.repository';

@Injectable()
export class VrfService {
  constructor(
    private readonly vrfRepository: VrfRepository,
    private readonly contextService: ContextService,
  ) {}

  async findById(id: string): Promise<Vrf> {
    this.contextService.requirePermission('ipam', 'read');
    return this.vrfRepository.restore(id);
  }

  async listVrfs(query: VrfListQuery): Promise<Vrf[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.vrfRepository.listVrfs(query);
  }

  async createVrf(input: CreateVrfRequest): Promise<Vrf> {
    this.contextService.requirePermission('ipam', 'create');
    const entity = VrfEntity.create(input, this.contextService.organizationId);
    await this.vrfRepository.ensureValidRd(entity);
    await this.vrfRepository.ensureNoConflict(entity, null);
    return this.vrfRepository.save(entity, null);
  }

  async updateVrf(id: string, input: UpdateVrfRequest): Promise<Vrf> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.vrfRepository.restore(id);
    const entity = VrfEntity.restore(before);
    entity.applyUpdate(input);
    await this.vrfRepository.ensureValidRd(entity);
    await this.vrfRepository.ensureNoConflict(entity, id);
    return this.vrfRepository.save(entity, before);
  }

  async archiveVrf(id: string): Promise<Vrf> {
    this.contextService.requirePermission('ipam', 'delete');
    const before = await this.vrfRepository.restore(id);
    const entity = VrfEntity.restore(before);
    entity.archive();
    return this.vrfRepository.save(entity, before);
  }
}
