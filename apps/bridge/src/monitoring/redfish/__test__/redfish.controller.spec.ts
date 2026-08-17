import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../oob/redfish-proxy.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../../oob/redfish-proxy.service.js')>(
    '../../../oob/redfish-proxy.service.js',
  );
  return {
    ...actual,
    createRedfishProxyService: vi.fn(),
  };
});

vi.mock('../../common/device-credential-resolver.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../common/device-credential-resolver.service.js')>(
    '../../common/device-credential-resolver.service.js',
  );
  return {
    ...actual,
    resolveMetricsTarget: vi.fn(),
    getDeviceCredentialResolver: vi.fn(),
  };
});

import { JobIdService } from '../../../common/job-id.service.js';
import { createRedfishProxyService, RedfishError } from '../../../oob/redfish-proxy.service.js';
import { resolveMetricsTarget } from '../../common/device-credential-resolver.service.js';
import { MonitoringRedfishController } from '../redfish.controller.js';

interface RecordedReply {
  status: number | null;
  body: unknown;
}

function recordingReply(): { reply: any; recorded: RecordedReply } {
  const recorded: RecordedReply = { status: null, body: null };
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
  return { headers: {}, ip: '127.0.0.1' };
}

function buildController(): MonitoringRedfishController {
  return new MonitoringRedfishController(new JobIdService());
}

function explicitCredsResolved(bmc = '10.0.0.1', user = 'admin', pw = 'secret') {
  return { ip: bmc, username: user, password: pw, usedResolver: false };
}

function makeProxy(returnValue: { status: number; content: Buffer; headers: Record<string, string> }): any {
  return {
    performRedfishOperation: vi.fn(async () => returnValue),
  };
}

describe('routes/monitoring/redfish — request validation', () => {
  beforeEach(() => {
    vi.mocked(createRedfishProxyService).mockReset();
    vi.mocked(resolveMetricsTarget).mockReset();
  });

  it('accepts a well-formed GET request and returns the parsed Redfish payload', async () => {
    vi.mocked(resolveMetricsTarget).mockResolvedValue(explicitCredsResolved());
    const proxy = makeProxy({
      status: 200,
      content: Buffer.from(JSON.stringify({ PowerConsumedWatts: 350 }), 'utf8'),
      headers: { 'Content-Type': 'application/json' },
    });
    vi.mocked(createRedfishProxyService).mockReturnValue(proxy);

    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'GET',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(200);
    const body = recorded.body as Record<string, unknown>;
    expect(body).toHaveProperty('PowerConsumedWatts', 350);
  });

  it('returns 400 when username is missing (no device_id fallback)', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'GET',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
    expect((recorded.body as Record<string, unknown>)['error']).toBeDefined();
  });

  it('returns 400 when password is missing (no device_id fallback)', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'GET',
        username: 'admin',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
    expect((recorded.body as Record<string, unknown>)['error']).toBeDefined();
  });
});

describe('routes/monitoring/redfish — SSRF constraints', () => {
  it('rejects endpoints that do not start with /redfish/v1/', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/etc/passwd',
        method: 'GET',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
    const body = recorded.body as Record<string, unknown>;
    const err = String(body['error']).toLowerCase();
    expect(err.includes('endpoint') || err.includes('pattern') || err.includes('regex')).toBe(true);
  });

  it('rejects relative paths', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: 'redfish/v1/Chassis',
        method: 'GET',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
  });

  it('rejects the DELETE method by schema', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'DELETE',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
    const body = recorded.body as Record<string, unknown>;
    expect(String(body['error']).toLowerCase()).toContain('method');
  });

  it('rejects the PATCH method by schema', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'PATCH',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
  });

  it('rejects the POST method by schema (only GET is allowed for metrics)', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Actions/ComputerSystem.Reset',
        method: 'POST',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
  });
});

describe('routes/monitoring/redfish — error handling', () => {
  beforeEach(() => {
    vi.mocked(createRedfishProxyService).mockReset();
    vi.mocked(resolveMetricsTarget).mockReset();
  });

  it('returns 400 when the redfish-proxy service raises RedfishError', async () => {
    vi.mocked(resolveMetricsTarget).mockResolvedValue(explicitCredsResolved());
    const proxy = {
      performRedfishOperation: vi.fn(async () => {
        throw new RedfishError('Connection refused');
      }),
    };
    vi.mocked(createRedfishProxyService).mockReturnValue(proxy as never);

    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'GET',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(400);
    expect(String((recorded.body as Record<string, unknown>)['error'])).toContain('Connection refused');
  });

  it('returns 500 with the Internal server error envelope on unexpected exceptions', async () => {
    vi.mocked(resolveMetricsTarget).mockResolvedValue(explicitCredsResolved());
    const proxy = {
      performRedfishOperation: vi.fn(async () => {
        throw new RangeError('boom');
      }),
    };
    vi.mocked(createRedfishProxyService).mockReturnValue(proxy as never);

    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(
      {
        bmc_ip: '10.0.0.1',
        endpoint: '/redfish/v1/Chassis/System.Embedded.1/Power',
        method: 'GET',
        username: 'admin',
        password: 'secret',
      },
      makeRequest(),
      reply,
    );

    expect(recorded.status).toBe(500);
    expect(String((recorded.body as Record<string, unknown>)['error'])).toContain('Internal server error');
  });

  it('returns 400 when no JSON body is provided', async () => {
    const controller = buildController();
    const { reply, recorded } = recordingReply();
    await controller.redfishMetrics(undefined, makeRequest(), reply);
    expect(recorded.status).toBe(400);
  });
});
