import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import type { ContextService } from 'src/common/context/context.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RackRoleService } from '../rack-role.service';

const denyOperator = () => {
  throw new ForbiddenException('operator only');
};
const mockContext = (requireInstanceOperator: () => void): ContextService =>
  ({ requireInstanceOperator }) as unknown as ContextService;

describe('RackRoleService catalog writes are operator-only', () => {
  afterEach(() => {
    ActiveRecordRegistry.configureForTest({}, null);
    vi.restoreAllMocks();
  });

  it('denies create/update/delete for a non-operator and never reaches the delegate', async () => {
    const delegate = { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
    ActiveRecordRegistry.configureForTest({ dcimRackRole: delegate }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
    const service = new RackRoleService(mockContext(denyOperator));

    await expect(service.create({ name: 'n', slug: 's' })).rejects.toThrow(ForbiddenException);
    await expect(service.update('missing', { name: 'n2' })).rejects.toThrow(ForbiddenException);
    await expect(service.delete('missing')).rejects.toThrow(ForbiddenException);

    expect(delegate.create).not.toHaveBeenCalled();
    expect(delegate.update).not.toHaveBeenCalled();
    expect(delegate.delete).not.toHaveBeenCalled();
  });

  it('reaches the record once the operator gate passes', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    ActiveRecordRegistry.configureForTest({ dcimRackRole: { findUnique } }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
    const service = new RackRoleService(mockContext(vi.fn()));

    await expect(service.delete('missing')).rejects.toThrow(NotFoundException);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'missing' } });
  });

  it('reads stay open — list does not gate', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    ActiveRecordRegistry.configureForTest({ dcimRackRole: { findMany } }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
    const service = new RackRoleService(mockContext(denyOperator));

    await expect(service.list()).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalled();
  });
});
