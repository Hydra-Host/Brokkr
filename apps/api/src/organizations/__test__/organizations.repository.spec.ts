import { ForbiddenException } from '@nestjs/common';
import { TenantType } from '@repo/database';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationsRepository } from '../organizations.repository';

const singleSupplyPolicy = { maxSupplyTenants: () => 1 };

describe('OrganizationsRepository.findMembership', () => {
  it('excludes soft-deleted memberships via deletedAt: null', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { member: { findFirst } } as unknown as PrismaClient;
    const repo = new OrganizationsRepository(prisma, singleSupplyPolicy);

    await repo.findMembership('user-1', 'org-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', organizationId: 'org-1', deletedAt: null },
    });
  });
});

describe('OrganizationsRepository.createOrganization — single-supplier cap', () => {
  it('rejects (and does not insert) a supply org once the cap is reached', async () => {
    const create = vi.fn();
    const count = vi.fn().mockResolvedValue(1);
    const executeRaw = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      $transaction: (cb: (tx: unknown) => unknown) => cb({ organization: { count, create }, $executeRaw: executeRaw }),
    } as unknown as PrismaClient;
    const repo = new OrganizationsRepository(prisma, singleSupplyPolicy);

    await expect(repo.createOrganization({ name: 'DC', tenantType: TenantType.SupplyCustomer })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('inserts a supply org while under the cap', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'org-2' });
    const count = vi.fn().mockResolvedValue(0);
    const executeRaw = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];
    create.mockImplementation(() => {
      callOrder.push('create');
      return { id: 'org-2' };
    });
    count.mockImplementation(() => {
      callOrder.push('count');
      return 0;
    });
    executeRaw.mockImplementation(() => {
      callOrder.push('lock');
      return undefined;
    });
    const prisma = {
      $transaction: (cb: (tx: unknown) => unknown) => cb({ organization: { count, create }, $executeRaw: executeRaw }),
    } as unknown as PrismaClient;
    const repo = new OrganizationsRepository(prisma, singleSupplyPolicy);

    await repo.createOrganization({ name: 'DC', tenantType: TenantType.SupplyCustomer });

    expect(create).toHaveBeenCalledWith({ data: { name: 'DC', tenantType: TenantType.SupplyCustomer } });
    expect(callOrder).toEqual(['lock', 'count', 'create']);
    expect(executeRaw.mock.calls[0]?.[0]?.join('?')).toContain('pg_advisory_xact_lock(hashtext(');
  });

  it('inserts a demand org directly, without the supply-cap transaction', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'org-3' });
    const $transaction = vi.fn();
    const prisma = { organization: { create }, $transaction } as unknown as PrismaClient;
    const repo = new OrganizationsRepository(prisma, { maxSupplyTenants: () => 0 });

    await repo.createOrganization({ name: 'Acme', tenantType: TenantType.DemandCustomer });

    expect(create).toHaveBeenCalledWith({ data: { name: 'Acme', tenantType: TenantType.DemandCustomer } });
    expect($transaction).not.toHaveBeenCalled();
  });
});
