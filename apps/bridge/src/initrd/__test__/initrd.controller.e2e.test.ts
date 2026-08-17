import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Global, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../../common/redis/redis.service.js';
import { ContextLogger } from '../../logger/logger.service.js';
import { InitrdOrchestrationService } from '../initrd-orchestration.service.js';
import { InitrdModule } from '../initrd.module.js';

@Global()
@Module({
  providers: [{ provide: ContextLogger, useValue: new ContextLogger() }],
  exports: [ContextLogger],
})
class LoggerStubModule {}

const orchestrationStub = {
  resolveDefaultDownload: vi.fn(),
  resolveDownloadByPath: vi.fn(),
};

const fakeRedis = {} as unknown as RedisService;

describe('InitrdController (e2e)', () => {
  let app: NestFastifyApplication;
  let tmpDir: string;
  let initrdFile: string;
  const initrdBytes = Buffer.from('INITRD-IMAGE-BYTES');

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'initrd-route-'));
    initrdFile = join(tmpDir, 'brokkr-live.img');
    await writeFile(initrdFile, initrdBytes);

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerStubModule,
        InitrdModule.forRoot({
          cache: fakeRedis,
          enqueueRenderRequest: vi.fn(async () => false),
        }),
      ],
    })
      .overrideProvider(InitrdOrchestrationService)
      .useValue(orchestrationStub)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    orchestrationStub.resolveDefaultDownload.mockReset();
    orchestrationStub.resolveDownloadByPath.mockReset();
  });

  it('serves the default brokkr-live initrd', async () => {
    orchestrationStub.resolveDefaultDownload.mockResolvedValueOnce({ initrdFile, scheduleCleanup: false });
    const res = await app.inject({ method: 'GET', url: '/api/initrd' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(initrdBytes.length));
    expect(res.headers['content-disposition']).toBe('attachment; filename=initrd-brokkr-brokkr-live.img');
    expect(res.headers['cache-control']).toBe('public, max-age=43200');
    expect(res.headers['expires']).toBeDefined();
    expect(res.rawPayload.equals(initrdBytes)).toBe(true);
    expect(orchestrationStub.resolveDefaultDownload).toHaveBeenCalledWith(expect.any(String), null);
  });

  it('passes the build query parameter through', async () => {
    orchestrationStub.resolveDefaultDownload.mockResolvedValueOnce({ initrdFile, scheduleCleanup: false });
    const res = await app.inject({ method: 'GET', url: '/api/initrd?build=bridge-agent' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename=initrd-brokkr-bridge-agent.img');
    expect(orchestrationStub.resolveDefaultDownload).toHaveBeenCalledWith(expect.any(String), 'bridge-agent');
  });

  it('returns 404 when the initrd build is missing', async () => {
    orchestrationStub.resolveDefaultDownload.mockResolvedValueOnce({ initrdFile: null, scheduleCleanup: false });
    const res = await app.inject({ method: 'GET', url: '/api/initrd' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Initrd build 'brokkr-live' not found" });
  });

  it('rejects invalid build names on the path route', async () => {
    orchestrationStub.resolveDownloadByPath.mockResolvedValueOnce({
      initrdFile: null,
      scheduleCleanup: false,
      invalidBuildName: true,
    });
    const res = await app.inject({ method: 'GET', url: '/api/initrd/evil.img' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Invalid build type. Supported: brokkr-live.img, bridge-agent.img, ' +
        'brokkr-discovery-{id}.img, brokkr-discovery-mac-{mac}.img, ' +
        'ubuntu-rescue-os-{id}.img',
    });
  });

  it('builds device initrds on demand and serves them uncacheable', async () => {
    orchestrationStub.resolveDownloadByPath.mockResolvedValueOnce({
      initrdFile,
      scheduleCleanup: true,
      secretBearing: true,
      invalidBuildName: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/initrd/brokkr-discovery-mac-aabbccddeeff.img',
      headers: { 'x-forwarded-for': '192.168.7.7' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename=initrd-brokkr-brokkr-discovery-mac-aabbccddeeff.img.img',
    );
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['expires']).toBeUndefined();
    expect(orchestrationStub.resolveDownloadByPath).toHaveBeenCalledWith(
      expect.any(String),
      'brokkr-discovery-mac-aabbccddeeff.img',
      '192.168.7.7',
    );
  });

  it('serves standard builds by path without on-demand build', async () => {
    orchestrationStub.resolveDownloadByPath.mockResolvedValueOnce({
      initrdFile,
      scheduleCleanup: false,
      invalidBuildName: false,
    });
    const res = await app.inject({ method: 'GET', url: '/api/initrd/brokkr-live.img' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when a path build is missing after build attempt', async () => {
    orchestrationStub.resolveDownloadByPath.mockResolvedValueOnce({
      initrdFile: null,
      scheduleCleanup: true,
      invalidBuildName: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/initrd/ubuntu-rescue-os-2efb2d6c-9b8a-4f55-9a39-307cd6e4a5f6.img',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Initrd build 'ubuntu-rescue-os-2efb2d6c-9b8a-4f55-9a39-307cd6e4a5f6.img' not found",
    });
  });

  it('maps service failures to 500 Internal server error', async () => {
    orchestrationStub.resolveDefaultDownload.mockRejectedValueOnce(new Error('boom'));
    const res = await app.inject({ method: 'GET', url: '/api/initrd' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
  });
});
