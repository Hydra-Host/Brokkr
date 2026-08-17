import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileServeService, FileServeServiceError } from '../../common/file-serve.service.js';
import { GrubModule } from '../grub.module.js';

describe('GrubController (e2e)', () => {
  let app: NestFastifyApplication;
  let tmpDir: string;
  let grubFile: string;
  const grubBytes = Buffer.from('GRUB-BINARY-CONTENT');
  const serveGrubFile = vi.fn();

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'grub-route-'));
    grubFile = join(tmpDir, 'bootx64.efi');
    await writeFile(grubFile, grubBytes);

    const moduleRef = await Test.createTestingModule({ imports: [GrubModule] })
      .overrideProvider(FileServeService)
      .useValue({ serveGrubFile })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('streams the GRUB file with attachment headers', async () => {
    serveGrubFile.mockResolvedValueOnce({
      filePath: grubFile,
      filename: 'bootx64.efi',
      mimeType: 'application/octet-stream',
    });
    const res = await app.inject({ method: 'GET', url: '/api/grub?arch=amd64&platform=efi' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(grubBytes.length));
    expect(res.headers['content-disposition']).toBe('attachment; filename=bootx64.efi');
    expect(res.rawPayload.equals(grubBytes)).toBe(true);
    expect(serveGrubFile).toHaveBeenCalledWith('amd64', 'efi');
    expect(res.headers['cache-control']).toBe('public, max-age=43200');
    expect(res.headers['last-modified']).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(res.headers['etag']).toMatch(/^"\d+(?:\.\d+)?-\d+-\d+"$/);
  });

  it('defaults to amd64/efi when query params are omitted', async () => {
    serveGrubFile.mockResolvedValueOnce({
      filePath: grubFile,
      filename: 'bootx64.efi',
      mimeType: 'application/octet-stream',
    });
    const res = await app.inject({ method: 'GET', url: '/api/grub' });
    expect(res.statusCode).toBe(200);
    expect(serveGrubFile).toHaveBeenCalledWith('amd64', 'efi');
  });

  it('maps invalid arch/platform service errors to 400', async () => {
    serveGrubFile.mockRejectedValueOnce(
      new FileServeServiceError('Invalid architecture or platform: arch=mips, platform=efi'),
    );
    const res = await app.inject({ method: 'GET', url: '/api/grub?arch=mips&platform=efi' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid architecture or platform: arch=mips, platform=efi' });
  });

  it('maps not-found service errors to 404', async () => {
    serveGrubFile.mockRejectedValueOnce(new FileServeServiceError('GRUB file not found: core.img'));
    const res = await app.inject({ method: 'GET', url: '/api/grub?arch=amd64&platform=pcbios' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'GRUB file not found: core.img' });
  });

  it('maps other service errors to 500 with the message', async () => {
    serveGrubFile.mockRejectedValueOnce(new FileServeServiceError('Error serving GRUB file: disk on fire'));
    const res = await app.inject({ method: 'GET', url: '/api/grub' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Error serving GRUB file: disk on fire' });
  });

  it('maps unexpected errors to 500 Internal server error', async () => {
    serveGrubFile.mockRejectedValueOnce(new Error('boom'));
    const res = await app.inject({ method: 'GET', url: '/api/grub' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
  });
});
