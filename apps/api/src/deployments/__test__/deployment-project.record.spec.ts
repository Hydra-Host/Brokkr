import { BadRequestException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentProjectRecord } from '../deployment-project.record';

describe('DeploymentProjectRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const orgId = 'org-1';

  const fullProject = {
    id: 'project-1',
    name: 'Default',
    organizationId: orgId,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ deploymentProject: mockDelegate }, () => ({
      organizationId: orgId,
      permissions: new Set<string>(['deployment-project:read']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('findActiveById', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullProject);
      const r = await DeploymentProjectRecord.findActiveById('project-1');

      expect(r?.data.id).toBe('project-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'project-1', deletedAt: null, organizationId: orgId },
      });
    });

    it('returns null when not found in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      const r = await DeploymentProjectRecord.findActiveById('project-1');
      expect(r).toBeNull();
    });

    it('cross-tenant isolation: a project owned by another tenant is invisible to the caller', async () => {
      const foreignProject = { ...fullProject, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignProject : null),
      );

      const r = await DeploymentProjectRecord.findActiveById('project-1');
      expect(r).toBeNull();
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'project-1', deletedAt: null, organizationId: orgId },
      });
    });
  });

  describe('findActiveAggregateById', () => {
    it('auto-scopes by ctx.organizationId and bakes the relation include', async () => {
      mockDelegate.findUnique.mockResolvedValue(fullProject);
      await DeploymentProjectRecord.findActiveAggregateById('project-1');

      expect(mockDelegate.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'project-1', deletedAt: null, organizationId: orgId },
          include: expect.any(Object),
        }),
      );
    });
  });

  describe('findActiveAggregates', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findMany.mockResolvedValue([fullProject]);
      await DeploymentProjectRecord.findActiveAggregates();

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, organizationId: orgId },
        }),
      );
    });
  });

  describe('findActiveDefault', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullProject);
      await DeploymentProjectRecord.findActiveDefault();

      expect(mockDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isDefault: true, deletedAt: null, organizationId: orgId },
        }),
      );
    });
  });

  describe('findActiveDefaultUnscoped (admin / saga path)', () => {
    it('uses the explicit orgId verbatim — no auto-injection from ctx', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullProject);
      await DeploymentProjectRecord.findActiveDefaultUnscoped('other-org');

      expect(mockDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'other-org', isDefault: true, deletedAt: null },
        }),
      );
    });
  });

  describe('createWithRelations (saga / org-create path)', () => {
    it('uses data.organizationId verbatim — no injection from ctx', async () => {
      mockDelegate.create.mockResolvedValue(fullProject);
      await DeploymentProjectRecord.createWithRelations({ name: 'New', organizationId: 'other-org' });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization: { connect: { id: 'other-org' } },
          }),
        }),
      );
    });
  });

  describe('createForCaller (request path)', () => {
    it('stamps organizationId from ctx', async () => {
      mockDelegate.create.mockResolvedValue(fullProject);
      await DeploymentProjectRecord.createForCaller({ name: 'My project' });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization: { connect: { id: orgId } },
          }),
        }),
      );
    });

    it('throws BadRequestException when no ctx is bound (request lost its org)', async () => {
      ActiveRecordRegistry.configureForTest({ deploymentProject: mockDelegate }, null);

      await expect(DeploymentProjectRecord.createForCaller({ name: 'x' })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('save() — _scopeWhere defense-in-depth', () => {
    it('threads organizationId from the record into the update where', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullProject);
      mockDelegate.update.mockResolvedValue({ ...fullProject, name: 'Renamed' });

      const record = await DeploymentProjectRecord.findActiveById('project-1');
      expect(record).not.toBeNull();
      record!.rename('Renamed');
      await record!.save();

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'project-1', organizationId: orgId },
          data: expect.objectContaining({ name: 'Renamed' }),
        }),
      );
    });
  });

  describe('addDeployment (relation mutation)', () => {
    it('uses the record own organizationId in the update where', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullProject);
      mockDelegate.update.mockResolvedValue(fullProject);

      const record = await DeploymentProjectRecord.findActiveById('project-1');
      await record!.addDeployment('dep-1');

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'project-1', organizationId: orgId },
        }),
      );
    });

    it('uses the record customerId/organizationId verbatim — does NOT inject from ctx', async () => {
      mockDelegate.update.mockResolvedValue(fullProject);
      const record = DeploymentProjectRecord.fromRow({ ...fullProject, organizationId: 'other-org' });

      await record.addDeployment('dep-1');

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'project-1', organizationId: 'other-org' },
        }),
      );
    });
  });
});
