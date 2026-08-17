import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../oob/redfish-proxy.service.js', () => ({
  createRedfishProxyService: vi.fn(),
  RedfishError: class RedfishError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RedfishError';
    }
  },
}));

vi.mock('../../common/device-credential-resolver.service', async () => {
  const actual = await vi.importActual<typeof import('../../common/device-credential-resolver.service')>(
    '../../common/device-credential-resolver.service',
  );
  return {
    ...actual,
    resolveMetricsTarget: vi.fn(),
    getDeviceCredentialResolver: vi.fn(),
  };
});

import { JobIdService } from '../../../common/job-id.service';
import { createRedfishProxyService } from '../../../oob/redfish-proxy.service.js';
import { getDeviceCredentialResolver, resolveMetricsTarget } from '../../common/device-credential-resolver.service';
import { MonitoringRedfishController } from '../redfish.controller';

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
  };
  return { reply, recorded };
}

function makeRequest(): any {
  return { headers: {} };
}

interface ProxyResult {
  status: number;
  content: Buffer;
  headers: Record<string, string>;
}

function proxyReturning(...results: ProxyResult[]) {
  const performRedfishOperation = vi.fn();
  for (const r of results) {
    performRedfishOperation.mockResolvedValueOnce(r);
  }
  return { performRedfishOperation };
}

const resolveMock = vi.mocked(resolveMetricsTarget);
const resolverMock = vi.mocked(getDeviceCredentialResolver);
const factoryMock = vi.mocked(createRedfishProxyService);

beforeEach(() => {
  resolveMock.mockReset();
  resolverMock.mockReset();
  factoryMock.mockReset();
  resolveMock.mockImplementation(async (args) => ({
    ip: args.ip ?? null,
    username: args.username ?? null,
    password: args.password ?? null,
    usedResolver: false,
  }));
});

function makeController(): MonitoringRedfishController {
  return new MonitoringRedfishController(new JobIdService());
}

describe('routes/monitoring — redfish', () => {
  it('uses explicit creds verbatim and never touches the resolver (back-compat path)', async () => {
    const service = proxyReturning({
      status: 200,
      content: Buffer.from('{"PowerConsumedWatts": 42}'),
      headers: {},
    });
    factoryMock.mockReturnValue(service as never);
    const controller = makeController();
    const { reply, recorded } = recordingReply();

    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/1/Power',
        username: 'u',
        password: 'p',
      },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(200);
    const sent = service.performRedfishOperation.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.bmc_ip).toBe('10.0.0.1');
    expect(sent.username).toBe('u');
  });

  it('resolves device_id to creds and forwards them on the proxy call', async () => {
    resolveMock.mockReset();
    resolveMock.mockResolvedValueOnce({
      ip: '172.16.32.10',
      username: 'USERID',
      password: 'secret',
      usedResolver: true,
    });
    resolverMock.mockReturnValue({} as never);
    const service = proxyReturning({
      status: 200,
      content: Buffer.from('{"ok": true}'),
      headers: {},
    });
    factoryMock.mockReturnValue(service as never);
    const controller = makeController();
    const { reply, recorded } = recordingReply();

    await controller.redfishMetrics(
      { device_id: '190', endpoint: '/redfish/v1/Chassis/1/Power' },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(200);
    const sent = service.performRedfishOperation.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.bmc_ip).toBe('172.16.32.10');
    expect(sent.username).toBe('USERID');
    expect(sent.password).toBe('secret');
  });

  it('busts the cache and retries once with rotated creds on a 401 against resolver-supplied creds', async () => {
    resolveMock.mockReset();
    resolveMock.mockResolvedValueOnce({
      ip: '172.16.32.10',
      username: 'USERID',
      password: 'stale',
      usedResolver: true,
    });
    const fakeResolver = {
      invalidate: vi.fn(),
      resolve: vi.fn().mockResolvedValue({ bmcIp: '172.16.32.10', username: 'USERID', password: 'rotated' }),
    };
    resolverMock.mockReturnValue(fakeResolver as never);
    const service = proxyReturning(
      { status: 401, content: Buffer.from('{"error": "unauthorized"}'), headers: {} },
      { status: 200, content: Buffer.from('{"PowerConsumedWatts": 7}'), headers: {} },
    );
    factoryMock.mockReturnValue(service as never);
    const controller = makeController();
    const { reply, recorded } = recordingReply();

    await controller.redfishMetrics(
      { device_id: '190', endpoint: '/redfish/v1/Chassis/1/Power' },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(200);
    expect(fakeResolver.invalidate).toHaveBeenCalledTimes(1);
    expect(fakeResolver.invalidate).toHaveBeenCalledWith('190');
    expect(service.performRedfishOperation).toHaveBeenCalledTimes(2);
    const retry = service.performRedfishOperation.mock.calls[1][0] as Record<string, unknown>;
    expect(retry.password).toBe('rotated');
  });

  it('does not bust the cache on a 401 from explicit caller creds', async () => {
    const fakeResolver = { invalidate: vi.fn() };
    resolverMock.mockReturnValue(fakeResolver as never);
    const service = proxyReturning({
      status: 401,
      content: Buffer.from('{"error": "unauthorized"}'),
      headers: {},
    });
    factoryMock.mockReturnValue(service as never);
    const controller = makeController();
    const { reply, recorded } = recordingReply();

    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/1/Power',
        username: 'u',
        password: 'p',
      },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(401);
    expect(fakeResolver.invalidate).not.toHaveBeenCalled();
    expect(service.performRedfishOperation).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when the device_id cannot be resolved', async () => {
    resolveMock.mockReset();
    resolveMock.mockResolvedValueOnce({
      ip: null,
      username: null,
      password: null,
      usedResolver: false,
    });
    const controller = makeController();
    const { reply, recorded } = recordingReply();

    await controller.redfishMetrics(
      { device_id: 'ghost', endpoint: '/redfish/v1/Chassis/1/Power' },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(400);
    expect(JSON.stringify(recorded.body)).toContain('ghost');
  });
});
