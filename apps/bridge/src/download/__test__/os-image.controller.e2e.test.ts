import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OsImageModule } from '../os-image.module.js';
import { resetPersistentStorageConfig, resetStorageConfig } from '../storage.config.js';

describe('OsImageController (e2e) — parity: always 500', () => {
  let app: NestFastifyApplication;
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'os-image-route-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    resetPersistentStorageConfig();
    resetStorageConfig();

    await mkdir(join(baseDir, 'os-layers'), { recursive: true });
    await writeFile(join(baseDir, 'os-layers', 'base-image.tar.zst'), 'LAYER-TARBALL-BYTES');
    await writeFile(join(baseDir, 'os-layers', 'notes.txt'), 'not a layer');
    await writeFile(join(baseDir, 'escape.tar.zst'), 'outside the cache dir');

    const moduleRef = await Test.createTestingModule({ imports: [OsImageModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.PERSISTENT_STORAGE_PATH;
    resetPersistentStorageConfig();
    resetStorageConfig();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('returns 500 for an existing OS layer (stub not wired)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/os-image/base-image.tar.zst' });
    expect(res.statusCode).toBe(500);
  });

  it('returns 500 for a missing layer (stub not wired)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/os-image/missing.tar.zst' });
    expect(res.statusCode).toBe(500);
  });

  it('returns 500 for files without an allowed suffix (stub not wired)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/os-image/notes.txt' });
    expect(res.statusCode).toBe(500);
  });

  it('returns 500 for path-traversal probes (stub not wired)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/os-image/..%2Fescape.tar.zst' });
    expect(res.statusCode).toBe(500);
  });
});
