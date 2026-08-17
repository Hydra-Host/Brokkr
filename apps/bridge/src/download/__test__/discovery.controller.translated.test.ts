import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JobIdService } from '../../common/job-id.service.js';
import { DiscoveryFileError, DiscoveryFileService } from '../discovery-file.service.js';
import { resetDiscoveryFileConfig } from '../discovery.config.js';
import { DiscoveryController } from '../discovery.controller.js';
import * as logger from '../download-logger.js';

interface RecordedResponse {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
}

function recordingReply(): { reply: any; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: null, headers: {}, body: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    header(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return reply;
    },
    async send(payload: unknown) {
      recorded.body = payload;
      return reply;
    },
  };
  return { reply, recorded };
}

function makeRequest(headers: Record<string, string> = {}): any {
  return { headers, ip: '127.0.0.1' };
}

interface StubServiceOverrides {
  discoveryDir?: string;
  getFileSize?: () => Promise<number | null> | number | null;
  getFileSizeError?: Error;
  streamChunks?: Buffer[];
}

function makeStubService(opts: StubServiceOverrides): DiscoveryFileService {
  const stub: any = {
    discoveryDir: opts.discoveryDir ?? '/bridge/discovery',
    getFileSize: vi.fn(async () => {
      if (opts.getFileSizeError !== undefined) throw opts.getFileSizeError;
      return typeof opts.getFileSize === 'function' ? opts.getFileSize() : (opts.getFileSize ?? 1024000);
    }),
    async *streamFile(): AsyncGenerator<Buffer, void, undefined> {
      for (const chunk of opts.streamChunks ?? [Buffer.from('file content')]) {
        yield chunk;
      }
    },
  };
  return stub as DiscoveryFileService;
}

async function makeController(opts: StubServiceOverrides): Promise<{
  controller: DiscoveryController;
  service: DiscoveryFileService;
  cleanup: () => Promise<void>;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), 'discovery-translated-'));
  const service = makeStubService({ ...opts, discoveryDir: baseDir });
  const jobIdService = new JobIdService();
  const controller = new DiscoveryController(jobIdService, service);
  const cleanup = async () => {
    await rm(baseDir, { recursive: true, force: true });
  };
  return { controller, service, cleanup };
}

async function writeAt(baseDir: string, arch: string, filename: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(baseDir, arch), { recursive: true });
  await writeFile(join(baseDir, arch, filename), Buffer.from('file content'));
}

describe('routes/download — discovery (translated from discovery download tests)', () => {
  describe('TestDiscoveryDownloadEndpoint', () => {
    it('returns 200 with octet-stream + Content-Disposition on a present file', async () => {
      const { controller, service, cleanup } = await makeController({});
      try {
        await writeAt(service.discoveryDir, 'amd64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(200);
        expect(recorded.headers['content-type']).toBe('application/octet-stream');
        expect(recorded.headers['content-disposition']).toBe('attachment; filename=discovery.iso');
      } finally {
        await cleanup();
      }
    });

    it('returns 400 when arch is missing', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(400);
      } finally {
        await cleanup();
      }
    });

    it('returns 400 when filename is missing', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64' }, makeRequest(), reply);
        expect(recorded.status).toBe(400);
      } finally {
        await cleanup();
      }
    });

    it('returns 400 when both parameters are missing', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({}, makeRequest(), reply);
        expect(recorded.status).toBe(400);
      } finally {
        await cleanup();
      }
    });

    it('returns 400 with Invalid architecture/amd64/arm64 message for unknown arch', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'invalid', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(400);
        const body = recorded.body as { error: string };
        expect(body.error).toMatch(/Invalid architecture/);
        expect(body.error).toMatch(/amd64/);
        expect(body.error).toMatch(/arm64/);
      } finally {
        await cleanup();
      }
    });

    it('rejects a path-segment arch even if a misconfigured DISCOVERY_ARCHITECTURES allows it', async () => {
      const prior = process.env.DISCOVERY_ARCHITECTURES;
      process.env.DISCOVERY_ARCHITECTURES = 'amd64,..';
      resetDiscoveryFileConfig();
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: '..', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(400);
      } finally {
        await cleanup();
        if (prior === undefined) delete process.env.DISCOVERY_ARCHITECTURES;
        else process.env.DISCOVERY_ARCHITECTURES = prior;
        resetDiscoveryFileConfig();
      }
    });

    it('returns 404 when the resolved file does not exist', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(404);
      } finally {
        await cleanup();
      }
    });

    it('returns 500 when getFileSize returns null', async () => {
      const { controller, service, cleanup } = await makeController({ getFileSize: () => null });
      try {
        await writeAt(service.discoveryDir, 'amd64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(500);
      } finally {
        await cleanup();
      }
    });

    it('returns 500 when DiscoveryFileService raises DiscoveryFileError', async () => {
      const { controller, service, cleanup } = await makeController({
        getFileSizeError: new DiscoveryFileError('Service error'),
      });
      try {
        await writeAt(service.discoveryDir, 'amd64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(500);
      } finally {
        await cleanup();
      }
    });

    it('returns 200 for arm64 architecture', async () => {
      const { controller, service, cleanup } = await makeController({});
      try {
        await writeAt(service.discoveryDir, 'arm64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'arm64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(200);
      } finally {
        await cleanup();
      }
    });

    it('accepts an arch added via DISCOVERY_ARCHITECTURES (download honors the same env as sync)', async () => {
      const prior = process.env.DISCOVERY_ARCHITECTURES;
      process.env.DISCOVERY_ARCHITECTURES = 'amd64,arm64,riscv64';
      resetDiscoveryFileConfig();
      const { controller, service, cleanup } = await makeController({});
      try {
        await writeAt(service.discoveryDir, 'riscv64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'riscv64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(200);
      } finally {
        await cleanup();
        if (prior === undefined) delete process.env.DISCOVERY_ARCHITECTURES;
        else process.env.DISCOVERY_ARCHITECTURES = prior;
        resetDiscoveryFileConfig();
      }
    });
  });

  describe('TestDiscoveryIntegration', () => {
    it('completes a download invocation (debug-to-download workflow)', async () => {
      const { controller, service, cleanup } = await makeController({});
      try {
        await writeAt(service.discoveryDir, 'amd64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(200);
      } finally {
        await cleanup();
      }
    });

    it('handles two concurrent download invocations', async () => {
      const { controller, service, cleanup } = await makeController({});
      try {
        await writeAt(service.discoveryDir, 'amd64', 'discovery.iso');
        const r1 = recordingReply();
        const r2 = recordingReply();
        await Promise.all([
          controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), r1.reply),
          controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), r2.reply),
        ]);
        expect(r1.recorded.status).toBe(200);
        expect(r2.recorded.status).toBe(200);
      } finally {
        await cleanup();
      }
    });

    it('logs the error when DiscoveryFileService raises DiscoveryFileError', async () => {
      const logErrorSpy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
      const { controller, service, cleanup } = await makeController({
        getFileSizeError: new DiscoveryFileError('Test error'),
      });
      try {
        await writeAt(service.discoveryDir, 'amd64', 'discovery.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'discovery.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(500);
        expect(logErrorSpy).toHaveBeenCalled();
      } finally {
        logErrorSpy.mockRestore();
        await cleanup();
      }
    });
  });

  describe('TestDiscoveryErrorHandling', () => {
    it('returns 500 when the discovery service throws an unexpected exception', async () => {
      const { controller, service, cleanup } = await makeController({
        getFileSizeError: new Error('Service creation failed'),
      });
      try {
        await writeAt(service.discoveryDir, 'amd64', 'test.iso');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: 'test.iso' }, makeRequest(), reply);
        expect(recorded.status).toBe(500);
      } finally {
        await cleanup();
      }
    });

    it('still surfaces a validation error gracefully when query is empty', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({}, makeRequest(), reply);
        expect([400, 500]).toContain(recorded.status);
      } finally {
        await cleanup();
      }
    });

    it('sanitizes filename via basename() so ../../../etc/passwd resolves under the arch dir', async () => {
      const { controller, service, cleanup } = await makeController({});
      try {
        await writeAt(service.discoveryDir, 'amd64', 'passwd');
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: 'amd64', filename: '../../../etc/passwd' }, makeRequest(), reply);
        expect(recorded.status).toBe(200);
        expect(recorded.headers['content-disposition']).toBe('attachment; filename=passwd');
      } finally {
        await cleanup();
      }
    });

    it('returns 400 with Invalid architecture for empty arch/filename', async () => {
      const { controller, cleanup } = await makeController({});
      try {
        const { reply, recorded } = recordingReply();
        await controller.downloadFile({ arch: '', filename: '' }, makeRequest(), reply);
        expect(recorded.status).toBe(400);
        const body = recorded.body as { error: string };
        expect(body.error).toMatch(/Invalid architecture|required/i);
      } finally {
        await cleanup();
      }
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });
});
