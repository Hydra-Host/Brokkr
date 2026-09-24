import { describe, expect, it, vi } from 'vitest';

import { findInstanceOperatorRecipients } from '../instance-operator-recipients';

describe('findInstanceOperatorRecipients', () => {
  it('returns members from one operator org with organizationId', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { organizationId: 'op-1', user: { id: 'u-1' } },
      { organizationId: 'op-1', user: { id: 'u-2' } },
      { organizationId: 'op-1', user: { id: 'u-1' } },
    ]);

    await expect(findInstanceOperatorRecipients(findMany)).resolves.toEqual({
      userIds: ['u-1', 'u-2'],
      organizationId: 'op-1',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { organization: { isInstanceOperator: true }, deletedAt: null },
      select: { organizationId: true, user: { select: { id: true } } },
    });
  });

  it('returns empty userIds without organizationId when there are no members', async () => {
    const findMany = vi.fn().mockResolvedValue([]);

    await expect(findInstanceOperatorRecipients(findMany)).resolves.toEqual({
      userIds: [],
    });
  });

  it('queries instance-operator members that are not deleted', async () => {
    const findMany = vi.fn().mockResolvedValue([]);

    await findInstanceOperatorRecipients(findMany);

    expect(findMany).toHaveBeenCalledWith({
      where: { organization: { isInstanceOperator: true }, deletedAt: null },
      select: { organizationId: true, user: { select: { id: true } } },
    });
  });
});
