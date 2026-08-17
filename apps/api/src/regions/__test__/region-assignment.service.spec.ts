import { describe, expect, it, vi } from 'vitest';
import { RegionAssignmentService } from '../region-assignment.service';

const REGION_ROW = {
  id: 'region-1',
  slug: 'north-america',
  priority: 90,
  centroidLat: 39,
  centroidLng: -77.5,
  boundary: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-170, 13],
          [-50, 13],
          [-50, 75],
          [-170, 75],
          [-170, 13],
        ],
      ],
    ],
  },
};

const DALLAS_ADDRESS = { latitude: 32.78, longitude: -96.8 };

function makeService(zoneRows: unknown[], zoneById: unknown = null) {
  const prisma = {
    region: { findMany: vi.fn().mockResolvedValue([REGION_ROW]) },
    zone: {
      findMany: vi.fn().mockResolvedValue(zoneRows),
      findUnique: vi.fn().mockResolvedValue(zoneById),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { service: new RegionAssignmentService(prisma as never, logger as never), prisma };
}

describe('RegionAssignmentService', () => {
  it('does not update a missing zone or an unchanged assignment', async () => {
    const missing = makeService([], null);
    await expect(missing.service.assignZone('missing')).resolves.toBeNull();
    expect(missing.prisma.zone.update).not.toHaveBeenCalled();

    const stable = makeService([], { regionId: 'region-1', addresses: [DALLAS_ADDRESS] });
    await expect(stable.service.assignZone('stable')).resolves.toBe('region-1');
    expect(stable.prisma.zone.update).not.toHaveBeenCalled();
  });

  it('atomically writes only changed assignments during a full recompute', async () => {
    const { service, prisma } = makeService([
      { id: 'changed', regionId: null, addresses: [DALLAS_ADDRESS] },
      { id: 'stable', regionId: 'region-1', addresses: [DALLAS_ADDRESS] },
      { id: 'no-coordinates', regionId: null, addresses: [] },
    ]);

    await expect(service.recomputeAllZones()).resolves.toEqual({ total: 3, assigned: 2, unassigned: 1 });

    expect(prisma.zone.update).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
