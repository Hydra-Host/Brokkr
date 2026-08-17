import { ActiveRecordRegistry } from '@repo/active-record';
import { LayerBuildStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerBuildRecord } from '../layer-build.record';

describe('LayerBuildRecord', () => {
  const mockDelegate = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ layerBuild: mockDelegate });
  });

  afterEach(() => vi.clearAllMocks());

  describe('findById', () => {
    it('returns the build row for a primary key', async () => {
      const row = { id: 'build-1', status: LayerBuildStatus.READY };
      mockDelegate.findUnique.mockResolvedValue(row);

      await expect(LayerBuildRecord.findById('build-1')).resolves.toEqual(row);
      expect(mockDelegate.findUnique).toHaveBeenCalledWith({ where: { id: 'build-1' } });
    });

    it('returns null when the build does not exist', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);
      await expect(LayerBuildRecord.findById('missing')).resolves.toBeNull();
    });
  });
});
