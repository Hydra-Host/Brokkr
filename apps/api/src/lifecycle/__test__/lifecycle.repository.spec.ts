import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleRepository } from '../lifecycle.repository';

vi.mock('@repo/layers', () => ({
  LayerRecord: { findBySlug: vi.fn().mockResolvedValue({ id: 'layer-1', kind: 'BASE' }) },
}));

const asPrisma = (m: object) => m as unknown as PrismaClient;

const orgScopedWhere = (ids: string[], organizationId: string) => ({
  id: { in: ids },
  dateDeleted: null,
  user: { members: { some: { organizationId, deletedAt: null } } },
});

describe('LifecycleRepository scopes SSH-key fetches to the org membership', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let findStorageDrives: ReturnType<typeof vi.fn>;

  const build = () => {
    findMany = vi.fn().mockResolvedValue([{ key: 'ssh-ed25519 AAAA' }]);
    findUnique = vi.fn().mockResolvedValue({ id: 'd1' });
    findStorageDrives = vi.fn().mockResolvedValue([]);
    const prisma = asPrisma({
      sshKeys: { findMany },
      storageDrive: { findMany: findStorageDrives },
      device: {
        findUnique,
      },
      $transaction: vi.fn((ops: unknown[]) => Promise.resolve(ops)),
    });
    return new LifecycleRepository(prisma);
  };

  beforeEach(() => vi.clearAllMocks());

  it('fetchProvisionableDevice scopes keys to org members (teammate keys allowed, cross-tenant rejected)', async () => {
    await build().fetchProvisionableDevice('d1', ['k1', 'k2'], 'ubuntu-22.04', 'org-1');
    expect(findMany).toHaveBeenCalledWith({ where: orgScopedWhere(['k1', 'k2'], 'org-1') });
  });

  it('fetchReprovisionableDevice scopes keys to org members', async () => {
    await build().fetchReprovisionableDevice('d1', ['k1'], 'ubuntu-22.04', 'org-2');
    expect(findMany).toHaveBeenCalledWith({ where: orgScopedWhere(['k1'], 'org-2') });
  });

  it('fetchSshPublicKeys scopes keys to org members', async () => {
    await build().fetchSshPublicKeys(['k1', 'k2'], 'org-3');
    expect(findMany).toHaveBeenCalledWith({ where: orgScopedWhere(['k1', 'k2'], 'org-3'), select: { key: true } });
  });

  it('loads current storage drives for a deferred provision', async () => {
    await build().fetchStorageDrives('d1');
    expect(findStorageDrives).toHaveBeenCalledWith({ where: { deviceId: 'd1' } });
  });

  it('loads storage drives for provision', async () => {
    await build().fetchProvisionableDevice('d1', ['k1'], 'ubuntu-22.04', 'org-1');
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: { storageDrives: true } }));
  });

  it('loads storage drives for reprovision', async () => {
    await build().fetchReprovisionableDevice('d1', ['k1'], 'ubuntu-22.04', 'org-1');
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ storageDrives: true }),
      }),
    );
  });
});
