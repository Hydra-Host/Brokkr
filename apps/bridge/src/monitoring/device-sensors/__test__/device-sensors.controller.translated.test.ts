import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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

import { getDeviceCredentialResolver, resolveMetricsTarget } from '../../common/device-credential-resolver.service';
import { DeviceSensorsController } from '../device-sensors.controller';
import type { DeviceSensorsService } from '../device-sensors.service';

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

function makeRequest(body: unknown): any {
  return { headers: {}, body, ip: '127.0.0.1' };
}

interface ServiceStub {
  authRejected: boolean;
  collect: Mock<(...args: any[]) => any>;
}

function makeController(stub: ServiceStub): DeviceSensorsController {
  return new DeviceSensorsController(stub as unknown as DeviceSensorsService);
}

const resolveMock = vi.mocked(resolveMetricsTarget);
const resolverMock = vi.mocked(getDeviceCredentialResolver);

beforeEach(() => {
  resolveMock.mockReset();
  resolverMock.mockReset();
});

describe('routes/monitoring — device-sensors', () => {
  it('resolves creds and returns the uniform document', async () => {
    resolveMock.mockResolvedValueOnce({
      ip: '172.16.32.40',
      username: 'USERID',
      password: 'secret',
      usedResolver: true,
    });
    const stub: ServiceStub = {
      authRejected: false,
      collect: vi.fn().mockResolvedValue({
        sensor_temperature_celsius: [{ sensor: 'Inlet', value: 21.0 }],
        gpu_power_watts: [],
      }),
    };
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({ device_id: '458' }), reply);

    expect(recorded.status).toBe(200);
    expect((recorded.body as Record<string, unknown>).sensor_temperature_celsius).toEqual([
      { sensor: 'Inlet', value: 21.0 },
    ]);
    const [calledId, creds] = stub.collect.mock.calls[0];
    expect(calledId).toBe('458');
    expect(creds.bmcIp).toBe('172.16.32.40');
    expect(creds.password).toBe('secret');
  });

  it('passes kind through to the service', async () => {
    resolveMock.mockResolvedValueOnce({
      ip: '10.4.0.14',
      username: 'admin',
      password: 'pw',
      usedResolver: true,
    });
    const stub: ServiceStub = {
      authRejected: false,
      collect: vi.fn().mockResolvedValue({ cdu_health_ok: [{ value: 1.0 }] }),
    };
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({ device_id: 'cdu-1', kind: 'cdu' }), reply);

    expect(recorded.status).toBe(200);
    expect(stub.collect.mock.calls[0][2]).toBe('cdu');
  });

  it('busts the cache and retries when auth was rejected on resolver-supplied creds', async () => {
    resolveMock.mockResolvedValueOnce({
      ip: '172.16.32.40',
      username: 'USERID',
      password: 'secret',
      usedResolver: true,
    });
    const stub: ServiceStub = {
      authRejected: true,
      collect: vi
        .fn()
        .mockResolvedValueOnce({ sensor_temperature_celsius: [] })
        .mockResolvedValueOnce({
          sensor_temperature_celsius: [{ sensor: 'Inlet', value: 30.0 }],
        }),
    };
    const fakeResolver = {
      invalidate: vi.fn(),
      resolve: vi.fn().mockResolvedValue({
        bmcIp: '172.16.32.40',
        username: 'USERID',
        password: 'rotated',
      }),
    };
    resolverMock.mockReturnValue(fakeResolver as never);
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({ device_id: '458' }), reply);

    expect(recorded.status).toBe(200);
    expect((recorded.body as Record<string, unknown>).sensor_temperature_celsius).toEqual([
      { sensor: 'Inlet', value: 30.0 },
    ]);
    expect(fakeResolver.invalidate).toHaveBeenCalledTimes(1);
    expect(fakeResolver.invalidate).toHaveBeenCalledWith('458');
    expect(stub.collect).toHaveBeenCalledTimes(2);
    expect(stub.collect.mock.calls[1][1].password).toBe('rotated');
  });

  it('does not retry on auth rejection when creds came from the caller (usedResolver=false)', async () => {
    resolveMock.mockResolvedValueOnce({
      ip: '172.16.32.40',
      username: 'USERID',
      password: 'secret',
      usedResolver: false,
    });
    const stub: ServiceStub = {
      authRejected: true,
      collect: vi.fn().mockResolvedValue({ sensor_temperature_celsius: [] }),
    };
    const fakeResolver = {
      invalidate: vi.fn(),
      resolve: vi.fn(),
    };
    resolverMock.mockReturnValue(fakeResolver as never);
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({ device_id: '458' }), reply);

    expect(recorded.status).toBe(200);
    expect(fakeResolver.invalidate).not.toHaveBeenCalled();
    expect(stub.collect).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when kind is not one of {server, cdu}', async () => {
    const stub: ServiceStub = { authRejected: false, collect: vi.fn() };
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({ device_id: 'x', kind: 'bogus' }), reply);

    expect(recorded.status).toBe(400);
  });

  it('returns 400 when the device_id cannot be resolved', async () => {
    resolveMock.mockResolvedValueOnce({
      ip: null,
      username: null,
      password: null,
      usedResolver: false,
    });
    const stub: ServiceStub = { authRejected: false, collect: vi.fn() };
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({ device_id: 'ghost' }), reply);

    expect(recorded.status).toBe(400);
    expect(JSON.stringify(recorded.body)).toContain('ghost');
  });

  it('returns 400 when device_id is missing', async () => {
    const stub: ServiceStub = { authRejected: false, collect: vi.fn() };
    const controller = makeController(stub);
    const { reply, recorded } = recordingReply();

    await controller.collect(makeRequest({}), reply);

    expect(recorded.status).toBe(400);
  });
});
