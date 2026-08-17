import { Injectable } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { CreateGatewayInput, GatewayRepository, UpdateGatewayInput } from './gateway.repository';

@Injectable()
export class GatewayService {
  constructor(
    private readonly contextService: ContextService,
    private readonly repo: GatewayRepository,
  ) {}

  private get organizationId(): string {
    return this.contextService.organizationId;
  }

  async list(query: { vrfId?: string; prefixId?: string }) {
    this.contextService.requirePermission('ipam', 'read');
    return this.repo.list(query, this.organizationId);
  }

  async findById(id: string) {
    this.contextService.requirePermission('ipam', 'read');
    return this.repo.findById(id, this.organizationId);
  }

  async create(input: CreateGatewayInput) {
    this.contextService.requirePermission('ipam', 'create');
    return this.repo.create(input, this.organizationId);
  }

  async update(id: string, input: UpdateGatewayInput) {
    this.contextService.requirePermission('ipam', 'update');
    return this.repo.update(id, input, this.organizationId);
  }

  async delete(id: string) {
    this.contextService.requirePermission('ipam', 'delete');
    return this.repo.delete(id, this.organizationId);
  }
}
