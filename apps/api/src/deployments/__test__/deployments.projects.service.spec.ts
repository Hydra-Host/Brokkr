import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry, PermissionContextRequiredError } from '@repo/active-record';
import { ContextService } from 'src/common/context/context.service';
import { LoggerService } from 'src/logger/logger.service';
import {
  mockDeployment,
  mockDeploymentProject,
  mockDevice,
  mockProjectWithDeployments,
  mockSupplyOrganization,
} from 'src/prisma/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance, type Mocked } from 'vitest';
import { DeploymentProjectRecord } from '../deployment-project.record';
import { DeploymentRecord } from '../deployment.record';
import { DeploymentsProjectsService } from '../services/deployments.projects.service';

const saveSpies = new WeakMap<object, MockInstance>();
function buildRecord(overrides: Partial<typeof mockDeploymentProject> = {}) {
  const record = DeploymentProjectRecord.fromRow({
    ...mockDeploymentProject,
    ...overrides,
  }) as DeploymentProjectRecord;
  saveSpies.set(record, vi.spyOn(record, 'save').mockResolvedValue(record));
  return record;
}

describe('DeploymentsProjectsService', () => {
  let service: DeploymentsProjectsService;
  let mockLogger: Mocked<LoggerService>;
  const mockContext = { requirePermission: vi.fn() };

  beforeEach(async () => {
    ActiveRecordRegistry.configureForTest({ deployment: {}, deploymentProject: {} }, () => ({
      organizationId: mockSupplyOrganization.id,
      permissions: new Set<string>(['deployment-project:read']),
    }));

    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Mocked<LoggerService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeploymentsProjectsService,
        {
          provide: 'LoggerServiceDeploymentsProjectsService',
          useValue: mockLogger,
        },
        { provide: ContextService, useValue: mockContext },
      ],
    }).compile();

    service = module.get<DeploymentsProjectsService>(DeploymentsProjectsService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createProject', () => {
    const createProjectDto = { name: 'New Project' };

    it('throws PermissionContextRequiredError when no request context is bound', async () => {
      ActiveRecordRegistry.configureForTest({ deployment: {}, deploymentProject: {} }, null);
      const createSpy = vi.spyOn(DeploymentProjectRecord, 'createForCaller');

      await expect(service.createProject({ name: 'X', isDefault: true })).rejects.toThrow(
        PermissionContextRequiredError,
      );

      expect(createSpy).not.toHaveBeenCalled();
    });

    it('creates a project via the record (auto-scoped to caller org)', async () => {
      const createForCallerSpy = vi
        .spyOn(DeploymentProjectRecord, 'createForCaller')
        .mockResolvedValue(mockProjectWithDeployments);

      const result = await service.createProject(createProjectDto);

      expect(createForCallerSpy).toHaveBeenCalledWith({ name: 'New Project', isDefault: false });
      expect(mockContext.requirePermission).toHaveBeenCalledWith('deployment-project', 'create');
      expect(result.id).toBe(mockDeploymentProject.id);
    });

    it('trims project name before creating', async () => {
      const createForCallerSpy = vi
        .spyOn(DeploymentProjectRecord, 'createForCaller')
        .mockResolvedValue(mockProjectWithDeployments);

      await service.createProject({ ...createProjectDto, name: '  New Project  ' });

      expect(createForCallerSpy).toHaveBeenCalledWith({ name: 'New Project', isDefault: false });
    });

    it('rethrows the original error on failure', async () => {
      vi.spyOn(DeploymentProjectRecord, 'createForCaller').mockRejectedValue(new Error('Database error'));

      await expect(service.createProject(createProjectDto)).rejects.toThrow('Database error');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('demotes the existing default when isDefault is true', async () => {
      const existingDefault = { ...mockProjectWithDeployments, isDefault: true };
      const existingDefaultRecord = buildRecord({ isDefault: true });

      vi.spyOn(DeploymentProjectRecord, 'findActiveDefault').mockResolvedValue(existingDefault);
      vi.spyOn(DeploymentProjectRecord, 'fromRow').mockReturnValueOnce(existingDefaultRecord);
      vi.spyOn(DeploymentProjectRecord, 'createForCaller').mockResolvedValue({
        ...mockProjectWithDeployments,
        isDefault: true,
      });

      const result = await service.createProject({ ...createProjectDto, isDefault: true });

      expect(existingDefaultRecord.data.isDefault).toBe(false);
      expect(saveSpies.get(existingDefaultRecord)).toHaveBeenCalled();
      expect(result.isDefault).toBe(true);
    });
  });

  describe('getProjectsForOrganization', () => {
    it('returns auto-scoped projects with formatted deployments', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregates').mockResolvedValue([mockProjectWithDeployments]);

      const result = await service.getProjectsForOrganization({});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toHaveProperty('id', mockDeploymentProject.id);
      expect(result.data[0]).toHaveProperty('deployments', []);
    });

    it('handles empty results', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregates').mockResolvedValue([]);

      const result = await service.getProjectsForOrganization({});

      expect(result.data).toEqual([]);
    });

    it('rethrows record errors', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregates').mockRejectedValue(new Error('Database error'));

      await expect(service.getProjectsForOrganization({})).rejects.toThrow('Database error');
    });
  });

  describe('getProjectById', () => {
    const getProjectDto = { projectId: mockDeploymentProject.id };

    it('returns the aggregate by id (auto-scoped)', async () => {
      const findSpy = vi
        .spyOn(DeploymentProjectRecord, 'findActiveAggregateById')
        .mockResolvedValue(mockProjectWithDeployments);

      const result = await service.getProjectById(getProjectDto);

      expect(findSpy).toHaveBeenCalledWith(mockDeploymentProject.id);
      expect(result.id).toBe(mockDeploymentProject.id);
    });

    it('throws NotFoundException when missing', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue(null);

      await expect(service.getProjectById(getProjectDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateProject', () => {
    const updateProjectDto = {
      projectId: mockDeploymentProject.id,
      data: { name: 'Updated Project' },
    };

    it('throws PermissionContextRequiredError when no request context is bound', async () => {
      ActiveRecordRegistry.configureForTest({ deployment: {}, deploymentProject: {} }, null);

      await expect(service.updateProject(updateProjectDto)).rejects.toThrow(PermissionContextRequiredError);
    });

    it('renames the project via the record', async () => {
      const record = buildRecord();
      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(record);
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockProjectWithDeployments,
        name: 'Updated Project',
      });

      const result = await service.updateProject(updateProjectDto);

      expect(record.data.name).toBe('Updated Project');
      expect(saveSpies.get(record)).toHaveBeenCalled();
      expect(result.name).toBe('Updated Project');
    });

    it('promotes to default and demotes the existing default', async () => {
      const record = buildRecord({ isDefault: false });
      const existingDefault = { ...mockProjectWithDeployments, id: 'existing-default', isDefault: true };
      const existingDefaultRecord = buildRecord({ id: 'existing-default', isDefault: true });

      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(record);
      vi.spyOn(DeploymentProjectRecord, 'findActiveDefault').mockResolvedValue(existingDefault);
      vi.spyOn(DeploymentProjectRecord, 'fromRow').mockReturnValueOnce(existingDefaultRecord);
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockProjectWithDeployments,
        isDefault: true,
      });

      const result = await service.updateProject({ ...updateProjectDto, data: { isDefault: true } });

      expect(existingDefaultRecord.data.isDefault).toBe(false);
      expect(saveSpies.get(existingDefaultRecord)).toHaveBeenCalled();
      expect(record.data.isDefault).toBe(true);
      expect(saveSpies.get(record)).toHaveBeenCalled();
      expect(result.isDefault).toBe(true);
    });

    it('rejects unsetting the default', async () => {
      const record = buildRecord({ isDefault: true });
      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(record);

      await expect(service.updateProject({ ...updateProjectDto, data: { isDefault: false } })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when the project is missing', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(null);

      await expect(service.updateProject(updateProjectDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteProject', () => {
    const deleteProjectDto = { projectId: mockDeploymentProject.id };

    it('soft-deletes a non-default project with no deployments', async () => {
      const aggregate = { ...mockProjectWithDeployments, isDefault: false, deployments: [] };
      const record = buildRecord({ isDefault: false });

      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregates').mockResolvedValue([
        aggregate,
        { ...mockProjectWithDeployments, id: 'other-project' },
      ]);
      vi.spyOn(DeploymentProjectRecord, 'fromRow').mockReturnValueOnce(record);

      await service.deleteProject(deleteProjectDto);

      expect(record.data.deletedAt).toBeInstanceOf(Date);
      expect(saveSpies.get(record)).toHaveBeenCalled();
    });

    it('rejects deleting a project that still has deployments', async () => {
      const aggregate = {
        ...mockProjectWithDeployments,
        deployments: [{ id: mockDeployment.id } as any],
      };
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);

      await expect(service.deleteProject(deleteProjectDto)).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when missing', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue(null);

      await expect(service.deleteProject(deleteProjectDto)).rejects.toThrow(NotFoundException);
    });

    it('rejects deleting the default project', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockProjectWithDeployments,
        isDefault: true,
        deployments: [],
      });

      await expect(service.deleteProject(deleteProjectDto)).rejects.toThrow(/Default project cannot be deleted/);
    });

    it('rejects deleting the last project', async () => {
      const aggregate = { ...mockProjectWithDeployments, isDefault: false, deployments: [] };
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentProjectRecord, 'findActiveAggregates').mockResolvedValue([aggregate]);

      await expect(service.deleteProject(deleteProjectDto)).rejects.toThrow(/Cannot delete the last project/);
    });
  });

  describe('addDeploymentToProject', () => {
    const addDeploymentDto = {
      projectId: mockDeploymentProject.id,
      deploymentId: mockDeployment.id,
    };

    const mockDeploymentForAdd = {
      id: mockDeployment.id,
      customerId: mockSupplyOrganization.id,
      deviceId: mockDevice.id,
    };

    it('adds the deployment via the record', async () => {
      const record = buildRecord();
      const addSpy = vi.spyOn(record, 'addDeployment').mockResolvedValue(mockProjectWithDeployments);
      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(record);
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(mockDeploymentForAdd as any);

      const result = await service.addDeploymentToProject(addDeploymentDto);

      expect(addSpy).toHaveBeenCalledWith(mockDeployment.id);
      expect(result.id).toBe(mockDeploymentProject.id);
    });

    it('throws NotFoundException when project missing', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(null);

      await expect(service.addDeploymentToProject(addDeploymentDto)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when deployment missing (or cross-tenant)', async () => {
      const record = buildRecord();
      vi.spyOn(DeploymentProjectRecord, 'findActiveById').mockResolvedValue(record);
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(null);

      await expect(service.addDeploymentToProject(addDeploymentDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('moveDeploymentsToProject', () => {
    const moveDto = {
      targetProjectId: 'project-456',
      sourceProjectId: mockDeploymentProject.id,
      deploymentIds: ['deployment-1', 'deployment-2'],
    };

    it('moves deployments via the record (after both projects verified)', async () => {
      const targetRecord = buildRecord({ id: 'project-456' });
      const sourceRecord = buildRecord();

      vi.spyOn(DeploymentProjectRecord, 'findActiveById')
        .mockResolvedValueOnce(targetRecord)
        .mockResolvedValueOnce(sourceRecord);
      const moveSpy = vi
        .spyOn(DeploymentProjectRecord, 'moveDeployments')
        .mockResolvedValue([mockProjectWithDeployments, mockProjectWithDeployments]);

      const result = await service.moveDeploymentsToProject(moveDto);

      expect(moveSpy).toHaveBeenCalledWith({
        targetProjectId: 'project-456',
        sourceProjectId: mockDeploymentProject.id,
        deploymentIds: ['deployment-1', 'deployment-2'],
      });
      expect(result.data).toHaveLength(2);
    });

    it('rejects when the target project is missing', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveById')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildRecord());

      await expect(service.moveDeploymentsToProject(moveDto)).rejects.toThrow(NotFoundException);
    });

    it('rethrows record errors', async () => {
      vi.spyOn(DeploymentProjectRecord, 'findActiveById')
        .mockResolvedValueOnce(buildRecord({ id: 'project-456' }))
        .mockResolvedValueOnce(buildRecord());
      vi.spyOn(DeploymentProjectRecord, 'moveDeployments').mockRejectedValue(new Error('Database error'));

      await expect(service.moveDeploymentsToProject(moveDto)).rejects.toThrow('Database error');
    });
  });
});
