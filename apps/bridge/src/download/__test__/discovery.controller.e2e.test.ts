import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoveryInventoryResponseSchema } from '../discovery-inventory.schema.js';
import { DiscoveryModule } from '../discovery.module.js';
import { resetPersistentStorageConfig, resetStorageConfig } from '../storage.config.js';

const FILE_SIZE = 1000;

describe('DiscoveryController (e2e)', () => {
  let app: NestFastifyApplication;
  let baseDir: string;
  let fileBytes: Buffer;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'discovery-route-'));
    process.env.PERSISTENT_STORAGE_PATH = baseDir;
    resetPersistentStorageConfig();
    resetStorageConfig();

    fileBytes = Buffer.alloc(FILE_SIZE);
    for (let i = 0; i < FILE_SIZE; i++) fileBytes[i] = i % 256;
    await mkdir(join(baseDir, 'brokkr-live', 'amd64'), { recursive: true });
    await writeFile(join(baseDir, 'brokkr-live', 'amd64', 'test.bin'), fileBytes);

    const moduleRef = await Test.createTestingModule({ imports: [DiscoveryModule] }).compile();
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

  it('serves the whole file via query parameters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovery?arch=amd64&filename=test.bin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(FILE_SIZE));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-disposition']).toBe('attachment; filename=test.bin');
    expect(res.rawPayload.equals(fileBytes)).toBe(true);
  });

  it('serves the whole file via path parameters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovery/amd64/test.bin' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(fileBytes)).toBe(true);
  });

  it('serves a byte range with 206 and Content-Range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/discovery/amd64/test.bin',
      headers: { range: 'bytes=10-19' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${FILE_SIZE}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.rawPayload.equals(fileBytes.subarray(10, 20))).toBe(true);
  });

  it('serves an open-ended range to the end of the file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/discovery/amd64/test.bin',
      headers: { range: 'bytes=990-' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 990-999/${FILE_SIZE}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.rawPayload.equals(fileBytes.subarray(990))).toBe(true);
  });

  it('serves a suffix range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/discovery/amd64/test.bin',
      headers: { range: 'bytes=-5' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 995-999/${FILE_SIZE}`);
    expect(res.headers['content-length']).toBe('5');
    expect(res.rawPayload.equals(fileBytes.subarray(995))).toBe(true);
  });

  it('clamps an over-long range to the file size', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/discovery/amd64/test.bin',
      headers: { range: 'bytes=900-5000' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 900-999/${FILE_SIZE}`);
    expect(res.headers['content-length']).toBe('100');
  });

  it('falls back to the full file for an invalid Range header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/discovery/amd64/test.bin',
      headers: { range: 'bytes=abc-' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(FILE_SIZE));
  });

  it('treats underscore digit separators as truncated integers (native parseInt)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/discovery/amd64/test.bin',
      headers: { range: 'bytes=1_0-1_9' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 1-1/${FILE_SIZE}`);
    expect(res.headers['content-length']).toBe('1');
    expect(res.rawPayload.equals(fileBytes.subarray(1, 2))).toBe(true);
  });

  it('rejects unsupported architectures', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovery/mips/test.bin' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid architecture. Supported: amd64, arm64' });
  });

  it('returns 404 for a missing file', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovery/amd64/missing.bin' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'File not found' });
  });

  it('returns 400 when query parameters are missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovery' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('reports required-file presence per arch on GET /api/discovery/inventory', async () => {
    await writeFile(join(baseDir, 'brokkr-live', 'amd64', 'vmlinuz'), fileBytes);

    const res = await app.inject({ method: 'GET', url: '/api/discovery/inventory' });
    expect(res.statusCode).toBe(200);

    const body = discoveryInventoryResponseSchema.parse(JSON.parse(res.body));
    const amd64 = body.architectures.find((a) => a.arch === 'amd64');
    expect(amd64).toBeDefined();

    const present = amd64?.files.find((f) => f.name === 'vmlinuz');
    expect(present?.present).toBe(true);
    expect(present?.sizeBytes).toBe(FILE_SIZE);
    expect(present?.mtimeMs).toBeGreaterThan(0);

    const absent = amd64?.files.find((f) => f.name === 'initrd.img');
    expect(absent).toEqual({ name: 'initrd.img', present: false, sizeBytes: 0, mtimeMs: 0 });
  });
});
