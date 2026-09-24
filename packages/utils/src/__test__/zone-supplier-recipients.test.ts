import { describe, expect, it, vi } from 'vitest';

import { findZoneSupplierRecipients } from '../zone-supplier-recipients';

describe('findZoneSupplierRecipients', () => {
  it('returns members of distinct supplier orgs for the zone', async () => {
    const findDevices = vi.fn().mockResolvedValue([{ supplierId: 'sup-a' }, { supplierId: 'sup-b' }]);
    const findMembers = vi.fn().mockResolvedValue([
      { organizationId: 'sup-a', user: { id: 'u-1' } },
      { organizationId: 'sup-b', user: { id: 'u-2' } },
      { organizationId: 'sup-b', user: { id: 'u-1' } },
    ]);

    await expect(findZoneSupplierRecipients('zone-1', findDevices, findMembers)).resolves.toEqual({
      userIds: ['u-1', 'u-2'],
    });

    expect(findDevices).toHaveBeenCalledWith({
      where: { zoneId: 'zone-1', deletedAt: null, supplierId: { not: null } },
      select: { supplierId: true },
      distinct: ['supplierId'],
    });
    expect(findMembers).toHaveBeenCalledWith({
      where: { organizationId: { in: ['sup-a', 'sup-b'] }, deletedAt: null },
      select: { organizationId: true, user: { select: { id: true } } },
    });
  });

  it('sets organizationId when there is a single supplier org', async () => {
    const findDevices = vi.fn().mockResolvedValue([{ supplierId: 'sup-a' }]);
    const findMembers = vi.fn().mockResolvedValue([{ organizationId: 'sup-a', user: { id: 'u-1' } }]);

    await expect(findZoneSupplierRecipients('zone-1', findDevices, findMembers)).resolves.toEqual({
      userIds: ['u-1'],
      organizationId: 'sup-a',
    });
  });

  it('returns no recipients when the zone has no supplier devices', async () => {
    const findDevices = vi.fn().mockResolvedValue([]);
    const findMembers = vi.fn();

    await expect(findZoneSupplierRecipients('zone-1', findDevices, findMembers)).resolves.toEqual({
      userIds: [],
    });
    expect(findMembers).not.toHaveBeenCalled();
  });
});
