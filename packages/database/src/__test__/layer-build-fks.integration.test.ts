import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const ON_DELETE = { RESTRICT: 'r', SET_NULL: 'n' } as const;

describe.skipIf(!connectionString)('layer build FK on-delete behavior (shipped migration)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function onDeleteActionFor(table: string, column: string): Promise<string | undefined> {
    const rows = await prisma.$queryRawUnsafe<{ confdeltype: string }[]>(
      `SELECT c.confdeltype::text AS confdeltype
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = $1::regclass
         AND a.attname = $2`,
      `"${table}"`,
      column,
    );
    return rows[0]?.confdeltype;
  }

  it('LayerArtifact.layerBuildId FK is ON DELETE RESTRICT', async () => {
    expect(await onDeleteActionFor('LayerArtifact', 'layerBuildId')).toBe(ON_DELETE.RESTRICT);
  });

  it('Zone.layerBuildId FK is ON DELETE SET NULL', async () => {
    expect(await onDeleteActionFor('Zone', 'layerBuildId')).toBe(ON_DELETE.SET_NULL);
  });

  it('PlatformSettings.defaultLayerBuildId FK is ON DELETE SET NULL', async () => {
    expect(await onDeleteActionFor('PlatformSettings', 'defaultLayerBuildId')).toBe(ON_DELETE.SET_NULL);
  });

  it('PlatformSettings singleton row was seeded by the migration', async () => {
    const row = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    expect(row).not.toBeNull();
    expect(row!.id).toBe('singleton');
    expect(row!.updatedAt).toBeInstanceOf(Date);
    expect(row!.defaultLayerBuildId).toBeNull();
  });

  it('RESTRICT rejects deletion of a build that has artifacts', async () => {
    const group = await prisma.layerGroup.create({
      data: { slug: `fk-test-grp-${Date.now()}`, name: 'FK Test Group', selectionType: 'SINGLE_SELECT' },
    });
    const layer = await prisma.layer.create({
      data: { slug: `fk-test-${Date.now()}`, name: 'FK Test', layerGroupId: group.id },
    });
    const build = await prisma.layerBuild.create({
      data: {
        version: `fk-restrict-${Date.now()}`,
        env: 'test',
        schemaVersion: 0,
        manifestUrl: 'n/a',
        status: 'IMPORTING',
      },
    });
    await prisma.layerArtifact.create({
      data: {
        layerId: layer.id,
        layerBuildId: build.id,
        osDistro: 'ubuntu',
        osCodename: 'noble',
        osVersion: '24.04',
        arch: 'amd64',
        sha256: `fk-restrict-${Date.now()}`,
        url: 'n/a',
        size: BigInt(0),
      },
    });
    await expect(prisma.layerBuild.delete({ where: { id: build.id } })).rejects.toThrow();
    await prisma.layerArtifact.deleteMany({ where: { layerBuildId: build.id } });
    await prisma.layerBuild.delete({ where: { id: build.id } });
    await prisma.layer.delete({ where: { id: layer.id } });
    await prisma.layerGroup.delete({ where: { id: group.id } });
  });

  it('SET NULL nullifies Zone.layerBuildId when the pinned build is deleted', async () => {
    const build = await prisma.layerBuild.create({
      data: {
        version: `fk-setnull-zone-${Date.now()}`,
        env: 'test',
        schemaVersion: 0,
        manifestUrl: 'n/a',
        status: 'IMPORTING',
      },
    });
    const org = await prisma.organization.create({
      data: { name: `fk-test-org-${Date.now()}`, tenantType: 'DemandCustomer' },
    });
    const zone = await prisma.zone.create({
      data: { name: `fk-test-zone-${Date.now()}`, organizationId: org.id, layerBuildId: build.id },
    });
    await prisma.layerBuild.delete({ where: { id: build.id } });
    const reloaded = await prisma.zone.findUnique({ where: { id: zone.id } });
    expect(reloaded!.layerBuildId).toBeNull();
    await prisma.zone.delete({ where: { id: zone.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  });

  it('SET NULL nullifies PlatformSettings.defaultLayerBuildId when the default build is deleted', async () => {
    const build = await prisma.layerBuild.create({
      data: {
        version: `fk-setnull-ps-${Date.now()}`,
        env: 'test',
        schemaVersion: 0,
        manifestUrl: 'n/a',
        status: 'IMPORTING',
      },
    });
    await prisma.platformSettings.update({
      where: { id: 'singleton' },
      data: { defaultLayerBuildId: build.id },
    });
    await prisma.layerBuild.delete({ where: { id: build.id } });
    const reloaded = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    expect(reloaded!.defaultLayerBuildId).toBeNull();
  });

  it('rejects duplicate LayerBuild (version, env) pairs', async () => {
    const ts = Date.now();
    await prisma.layerBuild.create({
      data: { version: `dup-${ts}`, env: 'test', schemaVersion: 0, manifestUrl: 'n/a', status: 'IMPORTING' },
    });
    await expect(
      prisma.layerBuild.create({
        data: { version: `dup-${ts}`, env: 'test', schemaVersion: 0, manifestUrl: 'n/a', status: 'IMPORTING' },
      }),
    ).rejects.toThrow();
    await prisma.layerBuild.deleteMany({ where: { version: `dup-${ts}`, env: 'test' } });
  });

  it('rejects duplicate LayerArtifact per build slot', async () => {
    const ts = Date.now();
    const group = await prisma.layerGroup.create({
      data: { slug: `uq-grp-${ts}`, name: 'Unique Test', selectionType: 'SINGLE_SELECT' },
    });
    const layer = await prisma.layer.create({
      data: { slug: `uq-layer-${ts}`, name: 'Unique Test', layerGroupId: group.id },
    });
    const build = await prisma.layerBuild.create({
      data: { version: `uq-${ts}`, env: 'test', schemaVersion: 0, manifestUrl: 'n/a', status: 'IMPORTING' },
    });
    const shared = {
      layerId: layer.id,
      layerBuildId: build.id,
      osDistro: 'ubuntu',
      osCodename: 'noble',
      osVersion: '24.04',
      arch: 'amd64',
      url: 'n/a',
      size: BigInt(0),
    };
    await prisma.layerArtifact.create({ data: { ...shared, sha256: `sha-a-${ts}` } });
    await expect(prisma.layerArtifact.create({ data: { ...shared, sha256: `sha-b-${ts}` } })).rejects.toThrow();
    await prisma.layerArtifact.deleteMany({ where: { layerBuildId: build.id } });
    await prisma.layerBuild.delete({ where: { id: build.id } });
    await prisma.layer.delete({ where: { id: layer.id } });
    await prisma.layerGroup.delete({ where: { id: group.id } });
  });

  it('rejects duplicate LayerArtifact (layerBuildId, sha256)', async () => {
    const ts = Date.now();
    const group = await prisma.layerGroup.create({
      data: { slug: `sha-grp-${ts}`, name: 'SHA Test', selectionType: 'SINGLE_SELECT' },
    });
    const layerA = await prisma.layer.create({
      data: { slug: `sha-layer-a-${ts}`, name: 'SHA A', layerGroupId: group.id },
    });
    const layerB = await prisma.layer.create({
      data: { slug: `sha-layer-b-${ts}`, name: 'SHA B', layerGroupId: group.id },
    });
    const build = await prisma.layerBuild.create({
      data: { version: `sha-${ts}`, env: 'test', schemaVersion: 0, manifestUrl: 'n/a', status: 'IMPORTING' },
    });
    const sha = `shared-sha-${ts}`;
    await prisma.layerArtifact.create({
      data: {
        layerId: layerA.id,
        layerBuildId: build.id,
        osDistro: 'ubuntu',
        osCodename: 'noble',
        osVersion: '24.04',
        arch: 'amd64',
        sha256: sha,
        url: 'n/a',
        size: BigInt(0),
      },
    });
    await expect(
      prisma.layerArtifact.create({
        data: {
          layerId: layerB.id,
          layerBuildId: build.id,
          osDistro: 'ubuntu',
          osCodename: 'noble',
          osVersion: '24.04',
          arch: 'amd64',
          sha256: sha,
          url: 'n/a',
          size: BigInt(0),
        },
      }),
    ).rejects.toThrow();
    await prisma.layerArtifact.deleteMany({ where: { layerBuildId: build.id } });
    await prisma.layerBuild.delete({ where: { id: build.id } });
    await prisma.layer.deleteMany({ where: { layerGroupId: group.id } });
    await prisma.layerGroup.delete({ where: { id: group.id } });
  });

  it('allows same sha256 under different builds (build-scoped, not global)', async () => {
    const ts = Date.now();
    const group = await prisma.layerGroup.create({
      data: { slug: `scope-grp-${ts}`, name: 'Scope Test', selectionType: 'SINGLE_SELECT' },
    });
    const layer = await prisma.layer.create({
      data: { slug: `scope-layer-${ts}`, name: 'Scope Test', layerGroupId: group.id },
    });
    const buildA = await prisma.layerBuild.create({
      data: { version: `scope-a-${ts}`, env: 'test', schemaVersion: 0, manifestUrl: 'n/a', status: 'IMPORTING' },
    });
    const buildB = await prisma.layerBuild.create({
      data: { version: `scope-b-${ts}`, env: 'test', schemaVersion: 0, manifestUrl: 'n/a', status: 'IMPORTING' },
    });
    const sha = `same-sha-${ts}`;
    const shared = {
      layerId: layer.id,
      osDistro: 'ubuntu',
      osCodename: 'noble',
      osVersion: '24.04',
      arch: 'amd64',
      sha256: sha,
      url: 'n/a',
      size: BigInt(0),
    };
    await prisma.layerArtifact.create({ data: { ...shared, layerBuildId: buildA.id } });
    await prisma.layerArtifact.create({ data: { ...shared, layerBuildId: buildB.id } });
    await prisma.layerArtifact.deleteMany({ where: { layerBuildId: { in: [buildA.id, buildB.id] } } });
    await prisma.layerBuild.deleteMany({ where: { id: { in: [buildA.id, buildB.id] } } });
    await prisma.layer.delete({ where: { id: layer.id } });
    await prisma.layerGroup.delete({ where: { id: group.id } });
  });
});
