import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../scripts/rbac/permissions', () => ({
  seedPermissions: vi.fn(),
  printSeedSummary: vi.fn(),
}));

import { printSeedSummary, seedPermissions } from '../../../scripts/rbac/permissions';
import { seedRbac } from '../seed-rbac';

const seedPermissionsMock = vi.mocked(seedPermissions);
const printSeedSummaryMock = vi.mocked(printSeedSummary);

function makeApp() {
  const prisma = { marker: 'prisma-client' };
  const app = { get: vi.fn(() => prisma) };
  return { app: app as never, prisma };
}

describe('seedRbac', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    seedPermissionsMock.mockReset();
    printSeedSummaryMock.mockReset();
  });

  it('seeds unconditionally in production with auth bypass disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HH_ENV', 'production');
    vi.stubEnv('AUTH_BYPASS_ENABLED', 'false');
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', 'false');
    const { app, prisma } = makeApp();
    const summary = { permissions: { created: 0, updated: 0, total: 0 }, roles: [] };
    seedPermissionsMock.mockResolvedValue(summary);

    await seedRbac(app);

    expect(seedPermissionsMock).toHaveBeenCalledExactlyOnceWith(prisma);
    expect(printSeedSummaryMock).toHaveBeenCalledExactlyOnceWith(summary);
  });

  it('propagates seeding failures instead of swallowing them', async () => {
    const { app } = makeApp();
    seedPermissionsMock.mockRejectedValue(new Error('Failed seeding system role "owner": boom'));

    await expect(seedRbac(app)).rejects.toThrow('Failed seeding system role "owner": boom');
    expect(printSeedSummaryMock).not.toHaveBeenCalled();
  });
});
