import { describe, expect, it, vi } from 'vitest';
import { RegionsService } from '../regions.service';

function makeService(regionCount: number) {
  const prisma = {
    region: {
      count: vi.fn().mockResolvedValue(regionCount),
      upsert: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { service: new RegionsService(prisma as never, logger as never), prisma };
}

describe('RegionsService.seedRegionsIfEmpty', () => {
  it('preserves an existing database-backed catalog', async () => {
    const { service, prisma } = makeService(1);

    await expect(service.seedRegionsIfEmpty()).resolves.toBe(0);

    expect(prisma.region.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('seeds the checked-in defaults atomically when the catalog is empty', async () => {
    const { service, prisma } = makeService(0);

    await expect(service.seedRegionsIfEmpty()).resolves.toBe(8);

    expect(prisma.region.upsert).toHaveBeenCalledTimes(8);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
