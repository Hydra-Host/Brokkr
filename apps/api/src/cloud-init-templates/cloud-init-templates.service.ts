import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { CloudInit, CloudInitTemplate, UpdateCloudInitTemplate } from '@repo/api-client';
import { paginateQuery, type PaginationQuery } from '@repo/database/pagination';
import { createHash } from 'node:crypto';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { cloudInitTemplatesPaginationConfig } from './cloud-init-templates.pagination';

@Injectable()
export class CloudInitTemplatesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    @Logger(CloudInitTemplatesService.name) private readonly logger: LoggerService,
  ) {}

  async saveFromProvision({
    cloudInit,
    cloudInitTemplateId,
    cloudInitTemplateName,
  }: {
    cloudInit?: string | null;
    cloudInitTemplateId?: string | null;
    cloudInitTemplateName?: string | null;
  }) {
    if (!cloudInit || cloudInit.trim() === '') return null;

    const organizationId = this.contextService.organizationId;
    const contentHash = this.hashContent(cloudInit);

    const audit = this.contextService.buildAuditPayload();

    if (cloudInitTemplateId) {
      this.contextService.requirePermission('cloud-init-template', 'update');
      const result = await this.prisma.cloudInitTemplate.updateMany({
        where: { id: cloudInitTemplateId, organizationId },
        data: { content: cloudInit, contentHash },
      });
      this.logger.log(
        `Cloud-init template "${cloudInitTemplateId}" content updated via provision | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
      );
      return result;
    }

    const existing = await this.prisma.cloudInitTemplate.findFirst({
      where: { organizationId, contentHash },
    });

    if (existing) return existing;

    const result = await this.prisma.cloudInitTemplate.create({
      data: {
        content: cloudInit,
        contentHash,
        organizationId,
        createdById: this.contextService.userId,
        ...(cloudInitTemplateName ? { name: cloudInitTemplateName } : {}),
      },
    });
    this.logger.log(
      `Cloud-init template "${result.id}" created via provision | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );
    return result;
  }

  async findById(id: string) {
    this.contextService.requirePermission('cloud-init-template', 'read');
    const organizationId = this.contextService.organizationId;
    const template = await this.prisma.cloudInitTemplate.findUnique({
      where: { id, organizationId },
    });

    if (!template) {
      throw new NotFoundException('Cloud-init template not found');
    }

    return template;
  }

  async resolveAndSave(data: {
    cloudInit?: CloudInit | null;
    cloudInitTemplateId?: string | null;
    cloudInitTemplateName?: string | null;
  }) {
    const { cloudInit, cloudInitTemplateId, cloudInitTemplateName } = data;
    if (!cloudInit && !cloudInitTemplateId) return null;

    if (cloudInitTemplateId && !cloudInit) {
      const template = await this.findById(cloudInitTemplateId);
      return template.content;
    }

    if (typeof cloudInit === 'string') {
      try {
        await this.saveFromProvision({ cloudInit, cloudInitTemplateId, cloudInitTemplateName });
      } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        this.logger.warn(`Failed to save cloud-init template: ${getErrorMessage(error)}`);
      }
    }

    return cloudInit;
  }

  async list(query: PaginationQuery) {
    this.contextService.requirePermission('cloud-init-template', 'read');
    const organizationId = this.contextService.organizationId;

    return paginateQuery<CloudInitTemplate>(this.prisma.cloudInitTemplate, query, cloudInitTemplatesPaginationConfig, {
      where: { organizationId },
    });
  }

  async update(id: string, data: UpdateCloudInitTemplate) {
    this.contextService.requirePermission('cloud-init-template', 'update');
    await this.findById(id);
    const organizationId = this.contextService.organizationId;

    const updateData: { name?: string; content?: string; contentHash?: string } = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.content !== undefined) {
      const newHash = this.hashContent(data.content);

      const existing = await this.prisma.cloudInitTemplate.findFirst({
        where: { organizationId, contentHash: newHash, id: { not: id } },
      });

      if (existing) {
        throw new HttpException(
          'A template with identical content already exists in this organization',
          HttpStatus.CONFLICT,
        );
      }

      updateData.content = data.content;
      updateData.contentHash = newHash;
    }

    await this.prisma.cloudInitTemplate.updateMany({
      where: { id, organizationId },
      data: updateData,
    });

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Cloud-init template "${id}" updated | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`);

    return this.findById(id);
  }

  async delete(id: string) {
    this.contextService.requirePermission('cloud-init-template', 'delete');
    const organizationId = this.contextService.organizationId;
    await this.findById(id);

    await this.prisma.cloudInitTemplate.deleteMany({
      where: { id, organizationId },
    });

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Cloud-init template "${id}" deleted | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`);
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
