import { describe, expect, it, vi } from 'vitest';
import { softDeleteDeviceNetworkAndSecrets } from '../soft-delete-device-network';

const ACTOR = { type: 'USER', id: 'user-1' } as never;
const NOW = new Date('2026-06-28T00:00:00Z');

function makeTx(ifaceIds: string[]) {
  return {
    interface: {
      findMany: vi.fn(async () => ifaceIds.map((id) => ({ id }))),
      updateMany: vi.fn(async () => ({ count: ifaceIds.length })),
    },
    ipAddress: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
}

describe('softDeleteDeviceNetworkAndSecrets', () => {
  it('soft-deletes the live interfaces, their IPs, and invalidates secrets in the caller tx', async () => {
    const tx = makeTx(['if-1', 'if-2']);
    const invalidateAll = vi.fn(async () => undefined);

    await softDeleteDeviceNetworkAndSecrets(
      tx as never,
      { invalidateAll } as never,
      'dev-1',
      ACTOR,
      'DEVICE_SOFT_DELETED',
      NOW,
    );

    expect(tx.ipAddress.updateMany).toHaveBeenCalledWith({
      where: { interfaceId: { in: ['if-1', 'if-2'] }, deletedAt: null },
      data: { deletedAt: NOW },
    });
    expect(tx.interface.updateMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1', deletedAt: null },
      data: { deletedAt: NOW },
    });
    expect(invalidateAll).toHaveBeenCalledWith('dev-1', ACTOR, 'DEVICE_SOFT_DELETED', tx);
  });

  it('skips the IP update when the device has no live interfaces (still tombstones interfaces + secrets)', async () => {
    const tx = makeTx([]);
    const invalidateAll = vi.fn(async () => undefined);

    await softDeleteDeviceNetworkAndSecrets(tx as never, { invalidateAll } as never, 'dev-2', ACTOR, 'cause', NOW);

    expect(tx.ipAddress.updateMany).not.toHaveBeenCalled();
    expect(tx.interface.updateMany).toHaveBeenCalledOnce();
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('propagates an invalidateAll failure so the caller transaction rolls back', async () => {
    const tx = makeTx(['if-1']);
    const invalidateAll = vi.fn(async () => {
      throw new Error('seal store down');
    });

    await expect(
      softDeleteDeviceNetworkAndSecrets(tx as never, { invalidateAll } as never, 'dev-3', ACTOR, 'cause', NOW),
    ).rejects.toThrow('seal store down');
  });
});
