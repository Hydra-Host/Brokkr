import type { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import { AuthRepository } from '../auth.repo';

describe('AuthRepository.findOrganizationMember', () => {
  it('excludes soft-deleted members and soft-deleted nested members', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { member: { findFirst } } as unknown as PrismaClient;
    const repo = new AuthRepository(prisma);

    await repo.findOrganizationMember('user-1', 'org-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', userId: 'user-1', deletedAt: null },
      include: {
        user: true,
        organization: { include: { members: { where: { deletedAt: null } } } },
      },
    });
  });
});
