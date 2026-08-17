import { ForbiddenException } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceModelRepository } from '../device-model.repository';
import { DeviceModelService } from '../device-model.service';

describe('DeviceModelService requirePermission gate', () => {
  const repo = { list: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const contextService = { requirePermission: vi.fn() };
  const service = new DeviceModelService(
    repo as unknown as DeviceModelRepository,
    contextService as unknown as ContextService,
  );

  const createInput = { manufacturer: 'Dell', model: 'R760' };

  beforeEach(() => {
    vi.clearAllMocks();
    contextService.requirePermission.mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('gates create and proceeds when allowed', async () => {
    await service.create(createInput);
    expect(contextService.requirePermission).toHaveBeenCalledWith('device-model', 'create');
    expect(repo.create).toHaveBeenCalledWith(createInput);
  });

  it('gates update and proceeds when allowed', async () => {
    await service.update('id', { model: 'R770' });
    expect(contextService.requirePermission).toHaveBeenCalledWith('device-model', 'update');
    expect(repo.update).toHaveBeenCalledWith('id', { model: 'R770' });
  });

  it('gates delete and proceeds when allowed', async () => {
    await service.delete('id');
    expect(contextService.requirePermission).toHaveBeenCalledWith('device-model', 'delete');
    expect(repo.delete).toHaveBeenCalledWith('id');
  });

  it('rejects writes and never touches the repo when requirePermission throws', async () => {
    contextService.requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.create(createInput)).rejects.toThrow(ForbiddenException);
    await expect(service.update('id', { model: 'R770' })).rejects.toThrow(ForbiddenException);
    await expect(service.delete('id')).rejects.toThrow(ForbiddenException);

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('gates reads behind device-model:read', async () => {
    await service.list();
    await service.findById('id');
    expect(contextService.requirePermission).toHaveBeenCalledWith('device-model', 'read');
    expect(contextService.requirePermission).toHaveBeenCalledTimes(2);
  });
});
