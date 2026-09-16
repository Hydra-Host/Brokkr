import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertParentDeviceOwnedOrSupplied } from '../parent-device.utils';

const mockDevice = { findUnique: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  ActiveRecordRegistry.configureForTest({ device: mockDevice }, () => ({
    organizationId: 'org-1',
    permissions: new Set<string>(),
  }));
});

describe('assertParentDeviceOwnedOrSupplied', () => {
  it('resolves when the device row is found (owner or supplier)', async () => {
    mockDevice.findUnique.mockResolvedValue({ id: 'device-1' });

    await expect(assertParentDeviceOwnedOrSupplied('device-1', 'org-1')).resolves.toBeUndefined();

    expect(mockDevice.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'device-1',
        deletedAt: null,
        supplierId: 'org-1',
      },
      select: { id: true },
    });
  });

  it('throws NotFoundException when findUnique returns null (unrelated org or soft-deleted)', async () => {
    mockDevice.findUnique.mockResolvedValue(null);

    await expect(assertParentDeviceOwnedOrSupplied('device-1', 'org-1')).rejects.toThrow(NotFoundException);
  });
});
