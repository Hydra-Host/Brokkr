import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformSettingsRecord } from '../platform-settings.record';

describe('PlatformSettingsRecord', () => {
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
    ActiveRecordRegistry.configureForTest({ platformSettings: mockDelegate });
  });

  afterEach(() => vi.clearAllMocks());

  describe('get', () => {
    it('returns the singleton row', async () => {
      const row = {
        id: 'singleton',
        defaultLayerBuildId: 'build-1',
        updatedById: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      mockDelegate.findUnique.mockResolvedValue(row);

      await expect(PlatformSettingsRecord.get()).resolves.toEqual(row);
      expect(mockDelegate.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } });
    });

    it('throws when the singleton row is missing (migrations not applied)', async () => {
      mockDelegate.findUnique.mockResolvedValue(null);

      await expect(PlatformSettingsRecord.get()).rejects.toThrow(/PlatformSettings singleton row is missing/);
    });
  });
});
