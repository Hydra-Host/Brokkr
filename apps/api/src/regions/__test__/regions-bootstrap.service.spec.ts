import { describe, expect, it, vi } from 'vitest';
import { RegionsBootstrapService } from '../regions-bootstrap.service';

function makeService(seedRegionsIfEmpty = vi.fn().mockResolvedValue(8)) {
  const regionsService = { seedRegionsIfEmpty };
  const regionAssignment = {
    recomputeAllZones: vi.fn().mockResolvedValue({ total: 3, assigned: 2, unassigned: 1 }),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new RegionsBootstrapService(regionsService as never, regionAssignment as never, logger as never);
  return { service, regionAssignment, logger };
}

describe('RegionsBootstrapService', () => {
  it('seeds an empty database and recomputes zone assignments', async () => {
    const { service, regionAssignment, logger } = makeService();

    await service.onApplicationBootstrap();

    expect(regionAssignment.recomputeAllZones).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('8 regions seeded'));
  });

  it('preserves existing database-backed regions', async () => {
    const { service, regionAssignment, logger } = makeService(vi.fn().mockResolvedValue(0));

    await service.onApplicationBootstrap();

    expect(regionAssignment.recomputeAllZones).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('fails soft when bootstrap data cannot be loaded', async () => {
    const { service, regionAssignment, logger } = makeService(vi.fn().mockRejectedValue(new Error('bad file')));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(regionAssignment.recomputeAllZones).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bad file'));
  });

  it('reports seeded-but-stale when only reassignment fails', async () => {
    const { service, regionAssignment, logger } = makeService();
    regionAssignment.recomputeAllZones.mockRejectedValue(new Error('database unavailable'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('seeded 8 regions'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('assignments may be stale'));
  });
});
