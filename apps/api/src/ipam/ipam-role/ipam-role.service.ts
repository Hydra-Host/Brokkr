import { Injectable } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { CreateIpamRoleInput, IpamRoleRepository, UpdateIpamRoleInput } from './ipam-role.repository';

@Injectable()
export class IpamRoleService {
  constructor(
    private readonly repo: IpamRoleRepository,
    private readonly contextService: ContextService,
  ) {}

  async list(search?: string) {
    this.contextService.requirePermission('ipam', 'read');
    return this.repo.list(search);
  }

  async findById(id: string) {
    this.contextService.requirePermission('ipam', 'read');
    return this.repo.findById(id);
  }

  async create(input: CreateIpamRoleInput) {
    this.contextService.requirePermission('ipam', 'create');
    return this.repo.create(input);
  }

  async update(id: string, input: UpdateIpamRoleInput) {
    this.contextService.requirePermission('ipam', 'update');
    return this.repo.update(id, input);
  }

  async delete(id: string) {
    this.contextService.requirePermission('ipam', 'delete');
    return this.repo.delete(id);
  }
}
