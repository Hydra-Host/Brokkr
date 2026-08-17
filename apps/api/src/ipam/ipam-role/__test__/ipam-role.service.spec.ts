import { ForbiddenException } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpamRoleRepository } from '../ipam-role.repository';
import { IpamRoleService } from '../ipam-role.service';

describe('IpamRoleService requirePermission gate', () => {
  const repo = { list: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const contextService = { requirePermission: vi.fn() };
  const service = new IpamRoleService(
    repo as unknown as IpamRoleRepository,
    contextService as unknown as ContextService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    contextService.requirePermission.mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('gates create and proceeds when allowed', async () => {
    await service.create({ name: 'n', slug: 's' });
    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'create');
    expect(repo.create).toHaveBeenCalledWith({ name: 'n', slug: 's' });
  });

  it('gates update and proceeds when allowed', async () => {
    await service.update('id', { name: 'n' });
    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'update');
    expect(repo.update).toHaveBeenCalledWith('id', { name: 'n' });
  });

  it('gates delete and proceeds when allowed', async () => {
    await service.delete('id');
    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'delete');
    expect(repo.delete).toHaveBeenCalledWith('id');
  });

  it('rejects writes and never touches the repo when requirePermission throws', async () => {
    contextService.requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.create({ name: 'n', slug: 's' })).rejects.toThrow(ForbiddenException);
    await expect(service.update('id', { name: 'n' })).rejects.toThrow(ForbiddenException);
    await expect(service.delete('id')).rejects.toThrow(ForbiddenException);

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('gates reads behind ipam:read', async () => {
    await service.list('q');
    await service.findById('id');
    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
    expect(contextService.requirePermission).toHaveBeenCalledTimes(2);
  });
});
