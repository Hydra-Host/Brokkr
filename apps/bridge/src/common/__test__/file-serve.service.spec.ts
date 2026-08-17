import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { FileServeService, FileServeServiceError, guessMimeType } from '../file-serve.service.js';
import { JobIdService } from '../job-id.service.js';

const statMock = vi.mocked(stat);

function fakeFileStat(): unknown {
  return { isFile: () => true };
}

function rejectedMissingStat(): Promise<never> {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return Promise.reject(err);
}

describe('FileServeService.serveGrubFile', () => {
  const ASSETS_DIR = '/bridge/assets';
  let service: FileServeService;
  let prevAssetsDir: string | undefined;

  beforeEach(() => {
    prevAssetsDir = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = ASSETS_DIR;
    service = new FileServeService(new JobIdService());
    statMock.mockReset();
  });

  afterEach(() => {
    if (prevAssetsDir === undefined) delete process.env.ASSETS_DIR;
    else process.env.ASSETS_DIR = prevAssetsDir;
  });

  it('amd64/efi success: returns bootx64.efi with application/efi mime', async () => {
    statMock.mockResolvedValue(fakeFileStat() as never);
    const result = await service.serveGrubFile('amd64', 'efi');
    expect(result.filePath).toBe(join(ASSETS_DIR, 'download', 'grub', 'bootx64.efi'));
    expect(result.filename).toBe('bootx64.efi');
    expect(['application/octet-stream', 'application/efi']).toContain(result.mimeType);
  });

  it('amd64/pcbios success: returns core.img with application/octet-stream', async () => {
    statMock.mockResolvedValue(fakeFileStat() as never);
    const result = await service.serveGrubFile('amd64', 'pcbios');
    expect(result.filePath).toBe(join(ASSETS_DIR, 'download', 'grub', 'core.img'));
    expect(result.filename).toBe('core.img');
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('arm64/efi success: returns bootaa64.efi', async () => {
    statMock.mockResolvedValue(fakeFileStat() as never);
    const result = await service.serveGrubFile('arm64', 'efi');
    expect(result.filePath).toBe(join(ASSETS_DIR, 'download', 'grub', 'bootaa64.efi'));
    expect(result.filename).toBe('bootaa64.efi');
    expect(['application/octet-stream', 'application/efi']).toContain(result.mimeType);
  });

  it('honors BRIDGE_ASSETS_DIR so grub assets share the docs/iPXE resolver root', async () => {
    const prevBridge = process.env.BRIDGE_ASSETS_DIR;
    delete process.env.ASSETS_DIR;
    process.env.BRIDGE_ASSETS_DIR = '/custom/bridge-assets';
    try {
      statMock.mockResolvedValue(fakeFileStat() as never);
      const result = await new FileServeService(new JobIdService()).serveGrubFile('amd64', 'efi');
      expect(result.filePath).toBe(join('/custom/bridge-assets', 'download', 'grub', 'bootx64.efi'));
    } finally {
      if (prevBridge === undefined) delete process.env.BRIDGE_ASSETS_DIR;
      else process.env.BRIDGE_ASSETS_DIR = prevBridge;
    }
  });

  it('invalid architecture raises FileServeServiceError', async () => {
    await expect(service.serveGrubFile('invalid', 'efi')).rejects.toThrowError(/Invalid architecture or platform/);
  });

  it('invalid platform raises FileServeServiceError', async () => {
    await expect(service.serveGrubFile('amd64', 'invalid')).rejects.toThrowError(/Invalid architecture or platform/);
  });

  it('unsupported arm64/pcbios combination raises FileServeServiceError', async () => {
    await expect(service.serveGrubFile('arm64', 'pcbios')).rejects.toThrowError(/Invalid architecture or platform/);
  });

  it('file not found raises FileServeServiceError', async () => {
    statMock.mockImplementation(rejectedMissingStat as never);
    await expect(service.serveGrubFile('amd64', 'efi')).rejects.toThrowError(/GRUB file not found/);
  });

  it('mime type detection routes .efi → application/efi via guessMimeType', () => {
    expect(guessMimeType('/x/bootx64.efi')).toBe('application/efi');
    expect(guessMimeType('/x/core.img')).toBe('application/octet-stream');
    expect(guessMimeType('/x/file.iso')).toBe('application/x-iso9660-image');
  });
});

describe('FileServeService — integration workflow', () => {
  let service: FileServeService;
  let prevAssetsDir: string | undefined;

  beforeEach(() => {
    prevAssetsDir = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = '/bridge/assets';
    service = new FileServeService(new JobIdService());
    statMock.mockReset();
    statMock.mockResolvedValue(fakeFileStat() as never);
  });

  afterEach(() => {
    if (prevAssetsDir === undefined) delete process.env.ASSETS_DIR;
    else process.env.ASSETS_DIR = prevAssetsDir;
  });

  it('complete grub serving workflow across all supported combos', async () => {
    const amd64Efi = await service.serveGrubFile('amd64', 'efi');
    expect(amd64Efi.filename).toBe('bootx64.efi');

    const amd64Pc = await service.serveGrubFile('amd64', 'pcbios');
    expect(amd64Pc.filename).toBe('core.img');

    const arm64Efi = await service.serveGrubFile('arm64', 'efi');
    expect(arm64Efi.filename).toBe('bootaa64.efi');
  });
});

describe('FileServeService — error edge cases', () => {
  let service: FileServeService;
  let prevAssetsDir: string | undefined;

  beforeEach(() => {
    prevAssetsDir = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = '/bridge/assets';
    service = new FileServeService(new JobIdService());
    statMock.mockReset();
  });

  afterEach(() => {
    if (prevAssetsDir === undefined) delete process.env.ASSETS_DIR;
    else process.env.ASSETS_DIR = prevAssetsDir;
  });

  it.each([
    ['', 'efi'],
    ['amd64', ''],
    ['ARM64', 'EFI'],
    ['x86_64', 'uefi'],
    ['aarch64', 'bios'],
  ])('rejects invalid arch/platform combo %s/%s', async (arch, platform) => {
    await expect(service.serveGrubFile(arch, platform)).rejects.toThrowError(FileServeServiceError);
  });

  it('concurrent valid requests all succeed', async () => {
    statMock.mockResolvedValue(fakeFileStat() as never);
    const tasks = [
      service.serveGrubFile('amd64', 'efi'),
      service.serveGrubFile('amd64', 'pcbios'),
      service.serveGrubFile('arm64', 'efi'),
      service.serveGrubFile('amd64', 'efi'),
      service.serveGrubFile('arm64', 'efi'),
    ];
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.filename).toMatch(/\.(efi|img)$/);
    }
  });
});
