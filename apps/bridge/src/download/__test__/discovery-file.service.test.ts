import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobIdModule } from '../../common/job-id.module.js';
import { DiscoveryFileError, DiscoveryFileService } from '../discovery-file.service.js';

async function collect(gen: AsyncGenerator<Buffer, void, undefined>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function collectChunks(gen: AsyncGenerator<Buffer, void, undefined>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

async function makeService(): Promise<DiscoveryFileService> {
  const moduleRef = await Test.createTestingModule({
    imports: [JobIdModule],
    providers: [DiscoveryFileService],
  }).compile();
  return moduleRef.get(DiscoveryFileService);
}

describe('DiscoveryFileService', () => {
  let dir: string;
  let filePath: string;
  const content = 'abcdefghijklmnopqrstuvwxyz';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'discovery-file-'));
    filePath = join(dir, 'image.iso');
    await writeFile(filePath, content);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the file size', async () => {
    const service = await makeService();
    expect(await service.getFileSize(filePath)).toBe(content.length);
  });

  it('returns null for a missing file', async () => {
    const service = await makeService();
    expect(await service.getFileSize(join(dir, 'missing.iso'))).toBeNull();
  });

  it('returns zero for an empty file', async () => {
    const service = await makeService();
    const emptyPath = join(dir, 'empty.iso');
    await writeFile(emptyPath, '');
    expect(await service.getFileSize(emptyPath)).toBe(0);
  });

  it('exposes the configured discovery directory', async () => {
    const service = await makeService();
    expect(typeof service.discoveryDir).toBe('string');
    expect(service.discoveryDir.length).toBeGreaterThan(0);
  });

  it('streams the whole file in chunks', async () => {
    const service = await makeService();
    const data = await collect(service.streamFile(filePath, { chunkSize: 5 }));
    expect(data.toString()).toBe(content);
  });

  it('streams a large file in the expected number of chunks', async () => {
    const service = await makeService();
    const largePath = join(dir, 'large.iso');
    const largeContent = Buffer.alloc(5000, 0x58);
    await writeFile(largePath, largeContent);

    const chunks = await collectChunks(service.streamFile(largePath, { chunkSize: 1024 }));
    const joined = Buffer.concat(chunks);
    expect(joined.equals(largeContent)).toBe(true);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBe(1024);
    }
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    expect(last!.length).toBeLessThanOrEqual(1024);
  });

  it('streams an empty file as zero chunks', async () => {
    const service = await makeService();
    const emptyPath = join(dir, 'empty-stream.iso');
    await writeFile(emptyPath, '');
    const chunks = await collectChunks(service.streamFile(emptyPath, { fileSize: 0 }));
    expect(chunks).toEqual([]);
  });

  it('auto-determines file size when none is provided', async () => {
    const service = await makeService();
    const data = await collect(service.streamFile(filePath, { chunkSize: 8 }));
    expect(data.toString()).toBe(content);
  });

  it('uses the configured chunk size when none is provided', async () => {
    const service = await makeService();
    const data = await collect(service.streamFile(filePath));
    expect(data.toString()).toBe(content);
  });

  it('streams an inclusive byte range', async () => {
    const service = await makeService();
    const data = await collect(service.streamFile(filePath, { chunkSize: 4, startByte: 2, endByte: 9 }));
    expect(data.toString()).toBe('cdefghij');
  });

  it('clamps out-of-bounds ranges to the file size', async () => {
    const service = await makeService();
    const data = await collect(service.streamFile(filePath, { startByte: 20, endByte: 99 }));
    expect(data.toString()).toBe('uvwxyz');
  });

  it('clamps an inverted range to a single trailing window', async () => {
    const service = await makeService();
    const data = await collect(service.streamFile(filePath, { startByte: 10, endByte: 5 }));
    expect(data.toString()).toBe('k');
  });

  it('throws DiscoveryFileError when the file cannot be streamed', async () => {
    const service = await makeService();
    await expect(collect(service.streamFile(join(dir, 'missing.iso')))).rejects.toThrow(DiscoveryFileError);
  });

  it('wraps stream errors with the "Failed to stream file" message', async () => {
    const service = await makeService();
    await expect(collect(service.streamFile(join(dir, 'missing.iso')))).rejects.toThrow(/Failed to stream file/);
  });
});
