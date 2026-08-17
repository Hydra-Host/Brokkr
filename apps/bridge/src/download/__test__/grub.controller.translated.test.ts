import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../common/send-file.js', () => ({
  sendFileAttachmentReply: vi.fn(async () => undefined),
}));

import { FileServeService, FileServeServiceError } from '../../common/file-serve.service.js';
import { JobIdService } from '../../common/job-id.service.js';
import { sendFileAttachmentReply } from '../../common/send-file.js';
import * as logger from '../download-logger.js';
import { GrubController } from '../grub.controller.js';

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
    raw: undefined,
    request: undefined,
  };
  return { reply, recorded };
}

function makeRequest(): any {
  return { headers: {}, ip: '127.0.0.1' };
}

interface StubServiceOverrides {
  serveResult?: { filePath: string; filename: string; mimeType: string };
  serveError?: Error;
}

function makeStubService(opts: StubServiceOverrides): FileServeService {
  const stub: any = {
    serveGrubFile: vi.fn(async () => {
      if (opts.serveError !== undefined) throw opts.serveError;
      return (
        opts.serveResult ?? {
          filePath: '/bridge/grub/amd64/efi/bootx64.efi',
          filename: 'bootx64.efi',
          mimeType: 'application/octet-stream',
        }
      );
    }),
  };
  return stub as FileServeService;
}

function makeController(opts: StubServiceOverrides): { controller: GrubController; service: FileServeService } {
  const service = makeStubService(opts);
  const jobIdService = new JobIdService();
  return { controller: new GrubController(jobIdService, service), service };
}

describe('routes/download — grub (translated from grub download tests)', () => {
  beforeEach(() => {
    vi.mocked(sendFileAttachmentReply).mockClear();
  });

  describe('TestGrubDownloadEndpoint', () => {
    it('serves a GRUB file via sendFileAttachmentReply on success', async () => {
      const { controller, service } = makeController({});
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), reply);
      expect(vi.mocked(sendFileAttachmentReply)).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(sendFileAttachmentReply).mock.calls[0];
      expect(callArgs[1]).toBe('/bridge/grub/amd64/efi/bootx64.efi');
      expect(callArgs[2]).toEqual({ filename: 'bootx64.efi', mimeType: 'application/octet-stream' });
      expect(recorded.status).toBeNull();
      expect(service.serveGrubFile).toHaveBeenCalledWith('amd64', 'efi');
    });

    it('uses amd64/efi defaults when no parameters are supplied', async () => {
      const { controller, service } = makeController({});
      const { reply } = recordingReply();
      await controller.downloadFile({}, makeRequest(), reply);
      expect(service.serveGrubFile).toHaveBeenCalledWith('amd64', 'efi');
      expect(vi.mocked(sendFileAttachmentReply)).toHaveBeenCalledOnce();
    });

    it('forwards arm64/efi to serveGrubFile', async () => {
      const { controller, service } = makeController({
        serveResult: {
          filePath: '/bridge/grub/arm64/efi/bootaa64.efi',
          filename: 'bootaa64.efi',
          mimeType: 'application/octet-stream',
        },
      });
      const { reply } = recordingReply();
      await controller.downloadFile({ arch: 'arm64', platform: 'efi' }, makeRequest(), reply);
      expect(service.serveGrubFile).toHaveBeenCalledWith('arm64', 'efi');
    });

    it('forwards amd64/pcbios to serveGrubFile', async () => {
      const { controller, service } = makeController({
        serveResult: {
          filePath: '/bridge/grub/amd64/pcbios/core.img',
          filename: 'core.img',
          mimeType: 'application/octet-stream',
        },
      });
      const { reply } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'pcbios' }, makeRequest(), reply);
      expect(service.serveGrubFile).toHaveBeenCalledWith('amd64', 'pcbios');
    });

    it('returns 400 when FileServeServiceError says "Invalid architecture or platform"', async () => {
      const { controller } = makeController({
        serveError: new FileServeServiceError('Invalid architecture or platform'),
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({ arch: 'invalid', platform: 'invalid' }, makeRequest(), reply);
      expect(recorded.status).toBe(400);
    });

    it('returns 404 when FileServeServiceError says "File not found"', async () => {
      const { controller } = makeController({
        serveError: new FileServeServiceError('File not found'),
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), reply);
      expect(recorded.status).toBe(404);
    });

    it('returns 500 for a generic FileServeServiceError', async () => {
      const { controller } = makeController({
        serveError: new FileServeServiceError('Service error'),
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), reply);
      expect(recorded.status).toBe(500);
    });

    it('returns 500 for an unexpected non-FileServeServiceError exception', async () => {
      const { controller } = makeController({ serveError: new Error('Unexpected error') });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), reply);
      expect(recorded.status).toBe(500);
    });
  });

  describe('TestGrubIntegration', () => {
    it('completes a GRUB download workflow on success', async () => {
      const { controller } = makeController({});
      const { reply } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), reply);
      expect(vi.mocked(sendFileAttachmentReply)).toHaveBeenCalledOnce();
    });

    it('handles two concurrent download invocations', async () => {
      const { controller } = makeController({
        serveResult: { filePath: '/bridge/grub/test', filename: 'test.efi', mimeType: 'application/octet-stream' },
      });
      const r1 = recordingReply();
      const r2 = recordingReply();
      await Promise.all([
        controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), r1.reply),
        controller.downloadFile({ arch: 'arm64', platform: 'efi' }, makeRequest(), r2.reply),
      ]);
      expect(vi.mocked(sendFileAttachmentReply)).toHaveBeenCalledTimes(2);
    });

    it('logs the error message and job id when serveGrubFile fails', async () => {
      const logErrorSpy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
      const { controller } = makeController({
        serveError: new FileServeServiceError('Test error'),
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({ arch: 'amd64', platform: 'efi' }, makeRequest(), reply);
      expect(recorded.status).toBe(500);
      expect(logErrorSpy).toHaveBeenCalled();
      const allCalls = logErrorSpy.mock.calls.map((c) => String(c[0]));
      expect(allCalls.some((s) => s.includes('Test error'))).toBe(true);
      logErrorSpy.mockRestore();
    });
  });

  describe('TestGrubErrorHandling', () => {
    it('returns 500 when the file-serve service throws an unexpected error', async () => {
      const { controller } = makeController({ serveError: new Error('Service creation failed') });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({}, makeRequest(), reply);
      expect(recorded.status).toBe(500);
    });

    it('issues a status code regardless of job-id extraction edge cases', async () => {
      const { controller } = makeController({ serveError: new Error('Job ID error') });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({}, makeRequest(), reply);
      expect(recorded.status).toBe(500);
    });

    it('returns 500 when sendFileAttachmentReply throws unexpectedly', async () => {
      vi.mocked(sendFileAttachmentReply).mockRejectedValueOnce(new Error('Send file error'));
      const { controller } = makeController({
        serveResult: {
          filePath: '/bridge/grub/test.efi',
          filename: 'test.efi',
          mimeType: 'application/octet-stream',
        },
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadFile({}, makeRequest(), reply);
      expect(recorded.status).toBe(500);
    });

    it.each([
      ['amd64', 'efi', 'bootx64.efi'],
      ['arm64', 'efi', 'bootaa64.efi'],
      ['amd64', 'pcbios', 'core.img'],
    ])('forwards %s/%s to serveGrubFile and reaches sendFile', async (arch, platform, expectedFilename) => {
      const { controller, service } = makeController({
        serveResult: {
          filePath: `/bridge/grub/${arch}/${platform}/${expectedFilename}`,
          filename: expectedFilename,
          mimeType: 'application/octet-stream',
        },
      });
      const { reply } = recordingReply();
      await controller.downloadFile({ arch, platform }, makeRequest(), reply);
      expect(service.serveGrubFile).toHaveBeenCalledWith(arch, platform);
      expect(vi.mocked(sendFileAttachmentReply)).toHaveBeenCalled();
    });
  });
});
