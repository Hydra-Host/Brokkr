import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../common/send-file.js', () => ({
  sendFileAttachment: vi.fn(async () => undefined),
}));

import { sendFileAttachment } from '../../common/send-file.js';
import { InitrdOrchestrationService } from '../initrd-orchestration.service.js';
import { InitrdController } from '../initrd.controller.js';

interface RecordedResponse {
  status: number | null;
  body: unknown;
}

function recordingReply(): { reply: any; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: null, body: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    async send(payload: unknown) {
      recorded.body = payload;
      return reply;
    },
    raw: undefined,
  };
  return { reply, recorded };
}

function makeRequest(): any {
  return { headers: {}, ip: '127.0.0.1' };
}

interface OrchestrationStub {
  resolveDefaultDownload: Mock<(...args: any[]) => any>;
  resolveDownloadByPath: Mock<(...args: any[]) => any>;
}

function makeController(): { controller: InitrdController; orch: OrchestrationStub } {
  const orch: OrchestrationStub = {
    resolveDefaultDownload: vi.fn(),
    resolveDownloadByPath: vi.fn(),
  };
  const controller = new InitrdController(orch as unknown as InitrdOrchestrationService);
  return { controller, orch };
}

describe('routes/download — initrd', () => {
  beforeEach(() => {
    vi.mocked(sendFileAttachment).mockClear();
  });

  describe('TestDownloadInitrd (GET /api/initrd)', () => {
    it('serves the default brokkr-live initrd via sendFileAttachment', async () => {
      const { controller, orch } = makeController();
      orch.resolveDefaultDownload.mockResolvedValueOnce({
        initrdFile: '/tmp/brokkr-live.img',
        scheduleCleanup: false,
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrd({}, reply);
      expect(vi.mocked(sendFileAttachment)).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(sendFileAttachment).mock.calls[0];
      expect(callArgs[1]).toBe('/tmp/brokkr-live.img');
      expect(callArgs[2].filename).toBe('initrd-brokkr-brokkr-live.img');
      expect(callArgs[2].mimeType).toBe('application/octet-stream');
      expect(recorded.status).toBeNull();
    });

    it('passes the build query parameter through to the resolver and filename', async () => {
      const { controller, orch } = makeController();
      orch.resolveDefaultDownload.mockResolvedValueOnce({
        initrdFile: '/tmp/bridge-agent.img',
        scheduleCleanup: false,
      });
      const { reply } = recordingReply();
      await controller.downloadInitrd({ build: 'brokkr-live' }, reply);
      const callArgs = vi.mocked(sendFileAttachment).mock.calls[0];
      expect(callArgs[2].filename).toBe('initrd-brokkr-brokkr-live.img');
      expect(orch.resolveDefaultDownload).toHaveBeenCalledWith(expect.any(String), 'brokkr-live');
    });

    it('returns 404 when the resolver reports no initrd file', async () => {
      const { controller, orch } = makeController();
      orch.resolveDefaultDownload.mockResolvedValueOnce({
        initrdFile: null,
        scheduleCleanup: false,
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrd({ build: 'nonexistent' }, reply);
      expect(recorded.status).toBe(404);
      const body = recorded.body as { error: string };
      expect(body.error).toMatch(/nonexistent.*not found|not found/i);
    });

    it('returns 404 when the resolved path is no longer on disk', async () => {
      const { controller, orch } = makeController();
      orch.resolveDefaultDownload.mockResolvedValueOnce({
        initrdFile: null,
        scheduleCleanup: false,
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrd({}, reply);
      expect(recorded.status).toBe(404);
    });

    it('returns 500 with the canonical body when the orchestration throws', async () => {
      const { controller, orch } = makeController();
      orch.resolveDefaultDownload.mockRejectedValueOnce(new Error('Disk error'));
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrd({}, reply);
      expect(recorded.status).toBe(500);
      expect(recorded.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('TestDownloadInitrdByPath (GET /api/initrd/:buildName)', () => {
    it('serves a standard brokkr-live.img request and skips on-demand build', async () => {
      const { controller, orch } = makeController();
      orch.resolveDownloadByPath.mockResolvedValueOnce({
        initrdFile: '/tmp/brokkr-live.img',
        scheduleCleanup: false,
        invalidBuildName: false,
      });
      const { reply } = recordingReply();
      await controller.downloadInitrdByPath('brokkr-live.img', makeRequest(), reply);
      const callArgs = vi.mocked(sendFileAttachment).mock.calls[0];
      expect(callArgs[2].filename).toBe('initrd-brokkr-brokkr-live.img.img');
      expect(orch.resolveDownloadByPath).toHaveBeenCalledWith(
        expect.any(String),
        'brokkr-live.img',
        expect.any(String),
      );
    });

    it('returns 400 when invalidBuildName is true', async () => {
      const { controller, orch } = makeController();
      orch.resolveDownloadByPath.mockResolvedValueOnce({
        initrdFile: null,
        scheduleCleanup: false,
        invalidBuildName: true,
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrdByPath('invalid_type', makeRequest(), reply);
      expect(recorded.status).toBe(400);
      const body = recorded.body as { error: string };
      expect(body.error).toMatch(/Invalid build type/);
    });

    it('returns 404 when the resolver reports no initrd file', async () => {
      const { controller, orch } = makeController();
      orch.resolveDownloadByPath.mockResolvedValueOnce({
        initrdFile: null,
        scheduleCleanup: false,
        invalidBuildName: false,
      });
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrdByPath('brokkr-live.img', makeRequest(), reply);
      expect(recorded.status).toBe(404);
    });

    it('forwards a brokkr-discovery-<id>.img request to resolveDownloadByPath with the client IP', async () => {
      const { controller, orch } = makeController();
      orch.resolveDownloadByPath.mockResolvedValueOnce({
        initrdFile: '/tmp/disco.img',
        scheduleCleanup: true,
        invalidBuildName: false,
      });
      const { reply } = recordingReply();
      await controller.downloadInitrdByPath(
        'brokkr-discovery-42.img',
        { headers: { 'x-forwarded-for': '172.16.8.10' }, ip: '172.16.8.10' },
        reply,
      );
      expect(orch.resolveDownloadByPath).toHaveBeenCalledWith(
        expect.any(String),
        'brokkr-discovery-42.img',
        '172.16.8.10',
      );
      expect(vi.mocked(sendFileAttachment)).toHaveBeenCalledOnce();
    });

    it('returns 500 with the canonical body when the orchestration throws', async () => {
      const { controller, orch } = makeController();
      orch.resolveDownloadByPath.mockRejectedValueOnce(new Error('Server error'));
      const { reply, recorded } = recordingReply();
      await controller.downloadInitrdByPath('brokkr-live.img', makeRequest(), reply);
      expect(recorded.status).toBe(500);
      expect(recorded.body).toEqual({ error: 'Internal server error' });
    });
  });
});
