import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { DeviceRole, DeviceStatus, LayerBuildStatus, TenantType, createPrismaClient } from '@repo/database';
import { setTimeout as sleep } from 'node:timers/promises';

interface SeededDevice {
  id: string;
  name: string;
}

interface AdminDb {
  prisma: ReturnType<typeof createPrismaClient>;
  activeMaintenanceCount: (deviceId: string) => Promise<number>;
}

interface SeededSite {
  facility: { id: string; name: string };
  colocation: { id: string; name: string };
  /** Second colocation under the same facility, for the confirm-move prompt. */
  otherColocation: { id: string; name: string };
}

interface AdminWorkerFixtures {
  adminDb: AdminDb;
  adminSeed: { device: SeededDevice; zoneId: string };
  adminSiteSeed: SeededSite;
  adminContext: BrowserContext;
}

interface AdminTestFixtures {
  adminPage: Page;
  /** A blank admin page; adminPage lands on the server detail route instead. */
  sitePage: Page;
  memberRequest: APIRequestContext;
}

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://brokkr:password@localhost:5432/brokkr';
const ADMIN_API_URL = process.env.ADMIN_API_URL ?? 'http://localhost:3211';
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL ?? 'http://localhost:5177';
const HYDRAHOST_ORGANIZATION_ID = process.env.HYDRAHOST_ORGANIZATION_ID ?? '00000000-0000-0000-0000-000000000000';

export const MEMBER_USER = { email: 'brokkr-1@brokkr.local', password: 'brokkr' };
export const OWNER_EMAIL = 'brokkr@brokkr.local';

const E2E_LAYER_BUILD_ID = '00000000-0000-4000-8000-00000000e2e0';
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 60;

const waitForBootstrapSeed = async (prisma: ReturnType<typeof createPrismaClient>): Promise<void> => {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const [organization, member] = await Promise.all([
      prisma.organization.findUnique({ where: { id: HYDRAHOST_ORGANIZATION_ID }, select: { id: true } }),
      prisma.user.findUnique({ where: { email: MEMBER_USER.email }, select: { id: true } }),
    ]);
    if (organization && member) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for admin-api bootstrap seed (org ${HYDRAHOST_ORGANIZATION_ID} + bypass users)`);
};

const ensureDefaultLayerBuild = async (prisma: ReturnType<typeof createPrismaClient>): Promise<void> => {
  const existing = await prisma.platformSettings.findUnique({
    where: { id: 'singleton' },
    select: { defaultLayerBuildId: true },
  });
  if (existing?.defaultLayerBuildId) return;

  const build = await prisma.layerBuild.upsert({
    where: { id: E2E_LAYER_BUILD_ID },
    update: {},
    create: {
      id: E2E_LAYER_BUILD_ID,
      version: 'e2e-admin',
      env: 'ci',
      schemaVersion: 1,
      manifestUrl: 'http://localhost/e2e/manifest.json',
      status: LayerBuildStatus.READY,
    },
  });
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    update: { defaultLayerBuildId: build.id },
    create: { id: 'singleton', defaultLayerBuildId: build.id },
  });
};

export const maintenanceCard = (page: Page) =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Device Maintenance' });

export const activeWindowSummary = (page: Page) => maintenanceCard(page).locator('.grid').first();

export const maintenanceHistoryRows = (page: Page) => maintenanceCard(page).locator('tbody tr');

export const errorToast = (page: Page, message: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: message });

export const relatedContactsCard = (page: Page) =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Related contacts' });

export const test = base.extend<AdminTestFixtures, AdminWorkerFixtures>({
  adminDb: [
    async ({}, use) => {
      const prisma = createPrismaClient({ connectionString: DATABASE_URL });
      await use({
        prisma,
        activeMaintenanceCount: (deviceId: string) =>
          prisma.deviceMaintenance.count({ where: { deviceId, disabledAt: null } }),
      });
      await prisma.$disconnect();
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  adminSeed: [
    async ({ adminDb }, use, workerInfo) => {
      const { prisma } = adminDb;
      await waitForBootstrapSeed(prisma);
      await ensureDefaultLayerBuild(prisma);

      const runId = process.env.E2E_RUN_ID ?? 'local';
      const tag = `${runId}-w${workerInfo.workerIndex}`;
      const zoneName = `E2E Admin Zone ${tag}`;
      const deviceName = `e2e-admin-node-${tag}`;

      await prisma.deviceMaintenance.deleteMany({ where: { device: { name: deviceName } } });
      await prisma.server.deleteMany({ where: { device: { name: deviceName } } });
      await prisma.device.deleteMany({ where: { name: deviceName } });
      await prisma.zoneMaintenance.deleteMany({ where: { zone: { name: zoneName } } });
      await prisma.zone.deleteMany({ where: { name: zoneName } });

      const organization = await prisma.organization.upsert({
        where: { id: HYDRAHOST_ORGANIZATION_ID },
        update: {},
        create: { id: HYDRAHOST_ORGANIZATION_ID, name: 'Brokkr Org', tenantType: TenantType.SupplyCustomer },
      });
      const zone = await prisma.zone.create({
        data: { name: zoneName, organizationId: organization.id },
      });
      const device = await prisma.device.create({
        data: {
          name: deviceName,
          role: DeviceRole.Server,
          status: DeviceStatus.ACTIVE,
          zoneId: zone.id,
          organizationId: organization.id,
          supplierId: organization.id,
          server: { create: {} },
        },
        select: { id: true, name: true },
      });

      await use({ device, zoneId: zone.id });

      await prisma.deviceMaintenance.deleteMany({ where: { deviceId: device.id } });
      await prisma.server.deleteMany({ where: { deviceId: device.id } });
      await prisma.device.deleteMany({ where: { id: device.id } });
      await prisma.zoneMaintenance.deleteMany({ where: { zoneId: zone.id } });
      await prisma.zone.deleteMany({ where: { id: zone.id } });
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  adminSiteSeed: [
    async ({ adminDb }, use, workerInfo) => {
      const { prisma } = adminDb;
      const tag = `${process.env.E2E_RUN_ID ?? 'local'}-w${workerInfo.workerIndex}`;
      const facilityName = `Acme ${tag}`;
      const colocationName = `Acme DC1 ${tag}`;
      const otherColocationName = `Acme DC2 ${tag}`;

      // Match on the worker tag rather than the exact seeded names: specs create
      // further facilities and colocations of their own (e.g. "<facility> extra"),
      // and every name embeds the tag. Matching exactly would leave those behind
      // and the next run would collide with the case-insensitive name indexes.
      const owned = { name: { contains: tag } };
      const purge = async () => {
        await prisma.contact.deleteMany({
          where: { OR: [{ facility: owned }, { colocation: owned }] },
        });
        await prisma.zone.updateMany({ where: { colocation: owned }, data: { colocationId: null } });
        await prisma.colocation.deleteMany({ where: owned });
        await prisma.facility.deleteMany({ where: owned });
      };

      await purge();

      const facility = await prisma.facility.create({
        data: { name: facilityName, operator: `Acme Operations ${tag}` },
        select: { id: true, name: true },
      });
      const [colocation, otherColocation] = await Promise.all([
        prisma.colocation.create({
          data: { name: colocationName, facilityId: facility.id },
          select: { id: true, name: true },
        }),
        prisma.colocation.create({
          data: { name: otherColocationName, facilityId: facility.id },
          select: { id: true, name: true },
        }),
      ]);

      await use({ facility, colocation, otherColocation });

      await purge();
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  adminContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ baseURL: ADMIN_BASE_URL });
      const page = await context.newPage();
      await page.goto('/login');
      await page
        .waitForURL((url) => !url.toString().includes('/login'), { timeout: 60_000 })
        .catch(() => {
          throw new Error(
            'admin-web stayed on /login — VITE_LOCAL_SIMULATION_ENABLED must be set for the sim auto-sign-in',
          );
        });
      await page.close();
      await use(context);
      await context.close();
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  adminPage: async ({ adminContext, adminSeed }, use) => {
    const page = await adminContext.newPage();
    await page.goto(`/servers/${adminSeed.device.id}`);
    await expect(maintenanceCard(page)).toBeVisible();
    await use(page);
    await page.close();
  },

  sitePage: async ({ adminContext }, use) => {
    const page = await adminContext.newPage();
    await use(page);
    await page.close();
  },

  memberRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: ADMIN_API_URL });
    const signIn = await context.post('/api/v1/admin/auth/sign-in/email', { data: MEMBER_USER });
    expect(signIn.status(), 'hydra-member sign-in should succeed').toBe(200);
    await use(context);
    await context.dispose();
  },
});

export { expect };
