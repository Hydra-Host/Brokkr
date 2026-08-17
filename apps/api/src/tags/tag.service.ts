import { Injectable } from '@nestjs/common';
import { CreateTagRequest, UpdateTagRequest } from '@repo/api-client';
import { TagRepository } from '@repo/tags';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class TagService {
  private readonly repo: TagRepository;

  constructor(
    private readonly contextService: ContextService,
    prisma: PrismaClient,
  ) {
    this.repo = new TagRepository(prisma);
  }

  private get organizationId(): string {
    return this.contextService.organizationId;
  }

  async list() {
    this.contextService.requirePermission('tag', 'read');
    return this.repo.list(this.organizationId);
  }

  async findById(id: string) {
    this.contextService.requirePermission('tag', 'read');
    return this.repo.findById(id, this.organizationId);
  }

  async create(input: CreateTagRequest) {
    this.contextService.requirePermission('tag', 'create');
    return this.repo.create(input, this.organizationId);
  }

  async update(id: string, input: UpdateTagRequest) {
    this.contextService.requirePermission('tag', 'update');
    return this.repo.update(id, input, this.organizationId);
  }

  async delete(id: string) {
    this.contextService.requirePermission('tag', 'delete');
    return this.repo.delete(id, this.organizationId);
  }
}
