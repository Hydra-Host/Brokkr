import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../bridge-status.service.js', async () => {
  const actual = await vi.importActual<typeof import('../bridge-status.service.js')>('../bridge-status.service.js');
  return {
    ...actual,
    createBridgeStatusService: vi.fn(),
  };
});

vi.mock('../../logger/logger.service.js', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
  ContextLogger: class {
    info = vi.fn(async () => {});
    warning = vi.fn(async () => {});
    error = vi.fn(async () => {});
    debug = vi.fn(async () => {});
  },
  getLogger: vi.fn(() => ({
    info: vi.fn(async () => {}),
    warning: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
  })),
}));

import { BridgeStatusController } from '../bridge-status.controller.js';
import { BridgeStatusServiceError, createBridgeStatusService } from '../bridge-status.service.js';

interface RecordedReply {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
}

function recordingReply(): { reply: any; recorded: RecordedReply } {
  const recorded: RecordedReply = { status: null, headers: {}, body: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    header(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload: unknown) {
      recorded.body = payload;
      return reply;
    },
  };
  return { reply, recorded };
}

function makeRequest(host = 'localhost:8000'): any {
  return { headers: { host }, ip: '127.0.0.1' };
}

describe('routes/status — bridge status', () => {
  let controller: BridgeStatusController;

  beforeEach(() => {
    controller = new BridgeStatusController();
    vi.mocked(createBridgeStatusService).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with the compiled status payload on success', async () => {
    const service = {
      getBridgeStatus: vi.fn(async () => ({
        bridge_pubkeys: ['ssh-rsa AAAA...'],
        bridge_url: 'http://localhost:8000',
        version: '1.0.0',
        leader_election: { is_leader: true },
      })),
    };
    vi.mocked(createBridgeStatusService).mockResolvedValue(service as never);

    const { reply, recorded } = recordingReply();
    await controller.status(makeRequest('localhost:8000'), reply);

    expect(recorded.status).toBe(200);
    const body = recorded.body as Record<string, unknown>;
    expect(body['bridge_url']).toBe('http://localhost:8000');
    expect(body['version']).toBe('1.0.0');
    expect(body).toHaveProperty('bridge_pubkeys');
    expect(body).toHaveProperty('leader_election');
  });

  it('returns 500 with the service error message when BridgeStatusServiceError is raised', async () => {
    const service = {
      getBridgeStatus: vi.fn(async () => {
        throw new BridgeStatusServiceError('Service unavailable');
      }),
    };
    vi.mocked(createBridgeStatusService).mockResolvedValue(service as never);

    const { reply, recorded } = recordingReply();
    await controller.status(makeRequest(), reply);

    expect(recorded.status).toBe(500);
    const body = recorded.body as Record<string, unknown>;
    expect(String(body['error'])).toContain('Service unavailable');
  });

  it('returns 500 with the Internal server error envelope on unexpected exceptions', async () => {
    const service = {
      getBridgeStatus: vi.fn(async () => {
        throw new Error('Unexpected error');
      }),
    };
    vi.mocked(createBridgeStatusService).mockResolvedValue(service as never);

    const { reply, recorded } = recordingReply();
    await controller.status(makeRequest(), reply);

    expect(recorded.status).toBe(500);
    const body = recorded.body as Record<string, unknown>;
    expect(String(body['error'])).toContain('Internal server error');
  });

  it('passes the host-derived bridge URL into the service call', async () => {
    const service = {
      getBridgeStatus: vi.fn(async () => ({
        bridge_pubkeys: [],
        bridge_url: 'http://bridge.example.com',
        version: '1.0.0',
      })),
    };
    vi.mocked(createBridgeStatusService).mockResolvedValue(service as never);

    const { reply, recorded } = recordingReply();
    await controller.status(makeRequest('bridge.example.com'), reply);

    expect(recorded.status).toBe(200);
    expect(service.getBridgeStatus).toHaveBeenCalledTimes(1);
    expect(service.getBridgeStatus).toHaveBeenCalledWith('http://bridge.example.com');
  });
});
