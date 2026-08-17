import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ContextService } from 'src/common/context/context.service';
import { createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudInitTemplatesService } from '../cloud-init-templates.service';

describe('CloudInitTemplatesService', () => {
  let service: CloudInitTemplatesService;
  let mockContextService: ContextService;

  const mockPrisma = {
    cloudInitTemplate: {
      upsert: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
  };

  beforeEach(async () => {
    mockContextService = {
      get organizationId() {
        return 'org-123';
      },
      get userId() {
        return 'user-456';
      },
      buildAuditPayload: () => ({
        triggeredBy: 'user-456',
        triggeredByEmail: 'test@test.com',
        organizationId: 'org-123',
      }),
      requirePermission: vi.fn(),
    } as unknown as ContextService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudInitTemplatesService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: ContextService, useValue: mockContextService },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    service = module.get<CloudInitTemplatesService>(CloudInitTemplatesService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('saveFromProvision', () => {
    it('should create a new template when no ID provided', async () => {
      const content = 'packages:\n  - nginx';
      const expected = { id: 'tpl-1', content, contentHash: expect.any(String) };
      mockPrisma.cloudInitTemplate.create.mockResolvedValue(expected);

      const result = await service.saveFromProvision({ cloudInit: content, cloudInitTemplateName: 'my-template' });

      expect(mockPrisma.cloudInitTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content,
          contentHash: expect.any(String),
          organizationId: 'org-123',
          createdById: 'user-456',
          name: 'my-template',
        }),
      });
      expect(result).toEqual(expected);
    });

    it('should update existing template when ID provided', async () => {
      const content = 'packages:\n  - nginx';
      mockPrisma.cloudInitTemplate.updateMany.mockResolvedValue({ count: 1 });

      await service.saveFromProvision({ cloudInit: content, cloudInitTemplateId: 'tpl-1' });

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('cloud-init-template', 'update');
      expect(mockPrisma.cloudInitTemplate.updateMany).toHaveBeenCalledWith({
        where: { id: 'tpl-1', organizationId: 'org-123' },
        data: { content, contentHash: expect.any(String) },
      });
    });

    it('should reject a template-content overwrite when requirePermission throws', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(
        service.saveFromProvision({ cloudInit: 'packages:\n  - nginx', cloudInitTemplateId: 'tpl-1' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.cloudInitTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('should not require the update permission when creating a new template', async () => {
      mockPrisma.cloudInitTemplate.findFirst.mockResolvedValue(null);
      mockPrisma.cloudInitTemplate.create.mockResolvedValue({ id: 'tpl-1' });

      await service.saveFromProvision({ cloudInit: 'packages:\n  - nginx' });

      expect(mockContextService.requirePermission).not.toHaveBeenCalled();
    });

    it('should return null when content is null or empty', async () => {
      expect(await service.saveFromProvision({ cloudInit: null })).toBeNull();
      expect(await service.saveFromProvision({ cloudInit: undefined })).toBeNull();
      expect(await service.saveFromProvision({ cloudInit: '' })).toBeNull();
      expect(mockPrisma.cloudInitTemplate.create).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should return template when found and active', async () => {
      const template = { id: 'tpl-1', organizationId: 'org-123', content: 'yaml' };
      mockPrisma.cloudInitTemplate.findUnique.mockResolvedValue(template);

      const result = await service.findById('tpl-1');
      expect(result).toEqual(template);
      expect(mockContextService.requirePermission).toHaveBeenCalledWith('cloud-init-template', 'read');
      expect(mockPrisma.cloudInitTemplate.findUnique).toHaveBeenCalledWith({
        where: { id: 'tpl-1', organizationId: 'org-123' },
      });
    });

    it('should throw 404 when template not found', async () => {
      mockPrisma.cloudInitTemplate.findUnique.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(
        new NotFoundException('Cloud-init template not found'),
      );
    });

    it('should reject before querying when the read permission is missing', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.findById('tpl-1')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.cloudInitTemplate.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('resolveAndSave', () => {
    it('should return null when neither cloudInit nor templateId provided', async () => {
      const result = await service.resolveAndSave({ cloudInit: null, cloudInitTemplateId: null });

      expect(result).toBeNull();
      expect(mockPrisma.cloudInitTemplate.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.cloudInitTemplate.create).not.toHaveBeenCalled();
      expect(mockPrisma.cloudInitTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('should resolve stored content via org-scoped findById when only templateId provided', async () => {
      const template = { id: 'tpl-1', organizationId: 'org-123', content: 'packages:\n  - nginx' };
      mockPrisma.cloudInitTemplate.findUnique.mockResolvedValue(template);

      const result = await service.resolveAndSave({ cloudInitTemplateId: 'tpl-1' });

      expect(result).toBe(template.content);
      expect(mockPrisma.cloudInitTemplate.findUnique).toHaveBeenCalledWith({
        where: { id: 'tpl-1', organizationId: 'org-123' },
      });
    });

    it('should return the input string and fire saveFromProvision on the string path', async () => {
      const content = 'packages:\n  - nginx';
      mockPrisma.cloudInitTemplate.findFirst.mockResolvedValue(null);
      mockPrisma.cloudInitTemplate.create.mockResolvedValue({ id: 'tpl-1', content });

      const result = await service.resolveAndSave({ cloudInit: content, cloudInitTemplateName: 'my-template' });

      expect(result).toBe(content);
      expect(mockPrisma.cloudInitTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ content, organizationId: 'org-123' }),
      });
    });

    it('should return an object cloudInit verbatim without persisting it', async () => {
      const cloudInit = { packages: ['nginx'] };

      const result = await service.resolveAndSave({ cloudInit });

      expect(result).toBe(cloudInit);
      expect(mockPrisma.cloudInitTemplate.create).not.toHaveBeenCalled();
      expect(mockPrisma.cloudInitTemplate.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.cloudInitTemplate.findFirst).not.toHaveBeenCalled();
    });

    it('should still return content when the swallowed save fails', async () => {
      const content = 'packages:\n  - nginx';
      mockPrisma.cloudInitTemplate.findFirst.mockResolvedValue(null);
      mockPrisma.cloudInitTemplate.create.mockRejectedValue(new Error('db down'));

      const result = await service.resolveAndSave({ cloudInit: content });

      expect(result).toBe(content);
    });

    it('should propagate a permission denial instead of swallowing it', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(
        service.resolveAndSave({ cloudInit: 'packages:\n  - nginx', cloudInitTemplateId: 'tpl-1' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.cloudInitTemplate.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should require a privileged role before deleting', async () => {
      const template = { id: 'tpl-1', organizationId: 'org-123' };
      mockPrisma.cloudInitTemplate.findUnique.mockResolvedValue(template);
      mockPrisma.cloudInitTemplate.deleteMany.mockResolvedValue({ count: 1 });

      await service.delete('tpl-1');

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('cloud-init-template', 'delete');
      expect(mockPrisma.cloudInitTemplate.deleteMany).toHaveBeenCalledWith({
        where: { id: 'tpl-1', organizationId: 'org-123' },
      });
    });

    it('should reject and not delete when requirePermission throws', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
      });

      await expect(service.delete('tpl-1')).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
      expect(mockPrisma.cloudInitTemplate.deleteMany).not.toHaveBeenCalled();
    });

    it('should reject a caller holding only the delete permission (no read)', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(
        (_resource: string, action: string) => {
          if (action === 'read') throw new ForbiddenException();
        },
      );

      await expect(service.delete('tpl-1')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.cloudInitTemplate.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.cloudInitTemplate.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should require a privileged role and update name only', async () => {
      const template = { id: 'tpl-1', organizationId: 'org-123', contentHash: 'abc' };
      mockPrisma.cloudInitTemplate.findUnique.mockResolvedValue(template);
      mockPrisma.cloudInitTemplate.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.update('tpl-1', { name: 'my-config' });

      expect(mockContextService.requirePermission).toHaveBeenCalledWith('cloud-init-template', 'update');
      expect(mockPrisma.cloudInitTemplate.updateMany).toHaveBeenCalledWith({
        where: { id: 'tpl-1', organizationId: 'org-123' },
        data: { name: 'my-config' },
      });
      expect(result).toEqual(template);
    });

    it('should reject and not update when requirePermission throws', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
      });

      await expect(service.update('tpl-1', { name: 'my-config' })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
      expect(mockPrisma.cloudInitTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('should reject a caller holding only the update permission (no read)', async () => {
      (mockContextService.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(
        (_resource: string, action: string) => {
          if (action === 'read') throw new ForbiddenException();
        },
      );

      await expect(service.update('tpl-1', { name: 'my-config' })).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.cloudInitTemplate.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.cloudInitTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('should reject content update when hash collides with existing template', async () => {
      const template = { id: 'tpl-1', organizationId: 'org-123', contentHash: 'old-hash' };
      mockPrisma.cloudInitTemplate.findUnique.mockResolvedValueOnce(template);
      mockPrisma.cloudInitTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl-2' });

      await expect(service.update('tpl-1', { content: 'new content' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        message: expect.stringContaining('already exists'),
      });
    });
  });
});
