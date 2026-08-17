import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { NIL_DEVICE_ID } from '../../../constants';
import {
  DeviceHealthService,
  HEALTH_FIELDS,
  RESULT_TTL_SECONDS,
  createDeviceHealthService,
  type DeviceHealthDeps,
  type HealthCheckResult,
} from '../device-health.service';

function allHealthy(deviceId = 'dev-1'): HealthCheckResult {
  return {
    device_id: deviceId,
    primary_reachable: true,
    bmc_icmp_reachable: true,
    bmc_ipmi_reachable: true,
    bmc_redfish_reachable: true,
    bmc_creds_valid: true,
    powered_on: true,
    brokkr_live_running: true,
    checked_at: 1_700_000_000,
  };
}

interface MockDeps extends DeviceHealthDeps {
  redis: {
    get: Mock<(...args: any[]) => any>;
    set: Mock<(...args: any[]) => any>;
  };
  queueAdd: Mock<(...args: any[]) => any>;
}

function buildDeps(
  options: {
    redisGet?: (k: string) => Promise<string | null>;
    redisSet?: (k: string, v: string, ttl: number) => Promise<unknown>;
    queue?: { add: Mock<(...args: any[]) => any> } | null;
    icmpPing?: number;
    brokkrConnected?: boolean;
    brokkrFactoryThrows?: boolean;
    brokkrConnThrows?: boolean;
  } = {},
): MockDeps {
  const redisGet = vi.fn(options.redisGet ?? (async () => null));
  const redisSet = vi.fn(options.redisSet ?? (async () => 'OK'));
  const queueAdd = options.queue?.add ?? vi.fn(async () => 'queued');
  const queueValue = options.queue === null ? null : { add: queueAdd };

  return {
    icmpFactory: {
      create: () => ({
        executePingTest: async () => ({ metrics: { icmpping: options.icmpPing ?? 1 } }),
      }),
    },
    brokkrLiveFactory: {
      create: async () => {
        if (options.brokkrFactoryThrows) throw new Error('factory broken');
        return {
          testDeviceConnectivity: async () => {
            if (options.brokkrConnThrows) throw new Error('conn broken');
            return { connected: options.brokkrConnected ?? true };
          },
        };
      },
    },
    resultsRedis: {
      get: async () =>
        ({
          get: (k: string) => redisGet(`bridge-zone:${k}`),
          set: (k: string, v: string, ttl: number) => redisSet(`bridge-zone:${k}`, v, ttl),
        }) as never,
    },
    resultsQueue: { get: async () => queueValue as never },
    jobStorage: { getBullmqPrefix: () => 'bridge-zone' },
    redis: { get: redisGet, set: redisSet },
    queueAdd,
  };
}

function svc(deps: MockDeps, jobId = 'job-test'): DeviceHealthService {
  return new DeviceHealthService(jobId, deps);
}

function patchInternalMethods(
  service: DeviceHealthService,
  overrides: {
    checkPing?: (ip: string) => Promise<boolean>;
    checkIpmiPing?: (ip: string) => Promise<boolean>;
    checkRedfishPing?: (ip: string) => Promise<boolean>;
    checkIpmiCreds?: (
      ip: string,
      u: string,
      p: string,
      id: string,
    ) => Promise<{ creds_valid: boolean | null; power_on: boolean | null }>;
    checkBrokkrLive?: (id: string) => Promise<boolean>;
    persistAndNotify?: (id: string, r: HealthCheckResult) => Promise<void>;
  },
): void {
  const proto = service as unknown as Record<string, unknown>;
  if (overrides.checkPing) proto.checkPing = overrides.checkPing;
  if (overrides.checkIpmiPing) proto.checkIpmiPing = overrides.checkIpmiPing;
  if (overrides.checkRedfishPing) proto.checkRedfishPing = overrides.checkRedfishPing;
  if (overrides.checkIpmiCreds) proto.checkIpmiCreds = overrides.checkIpmiCreds;
  if (overrides.checkBrokkrLive) proto.checkBrokkrLive = overrides.checkBrokkrLive;
  if (overrides.persistAndNotify) proto.persistAndNotify = overrides.persistAndNotify;
}

describe('healthChanged', () => {
  it('null previous → changed', () => {
    expect(DeviceHealthService.healthChanged(null, allHealthy() as unknown as Record<string, unknown>)).toBe(true);
  });

  it('identical except checked_at → not changed', () => {
    const prev = { ...allHealthy(), checked_at: 1_699_999_000 } as unknown as Record<string, unknown>;
    const cur = allHealthy() as unknown as Record<string, unknown>;
    expect(DeviceHealthService.healthChanged(prev, cur)).toBe(false);
  });

  it('one allowlisted field flipped → changed', () => {
    const prev = { ...allHealthy(), powered_on: false } as unknown as Record<string, unknown>;
    expect(DeviceHealthService.healthChanged(prev, allHealthy() as unknown as Record<string, unknown>)).toBe(true);
  });
});

describe('HEALTH_FIELDS snapshot', () => {
  it('lists the seven allowlisted boolean fields', () => {
    expect(HEALTH_FIELDS).toEqual([
      'primary_reachable',
      'bmc_icmp_reachable',
      'bmc_ipmi_reachable',
      'bmc_redfish_reachable',
      'bmc_creds_valid',
      'powered_on',
      'brokkr_live_running',
    ]);
  });
});

describe('checkDeviceHealth orchestration', () => {
  it('all probes succeed → result has every field True and persist invoked', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    const persist = vi.fn(async () => {});
    const pingMock = vi.fn(async () => true);
    patchInternalMethods(service, {
      checkPing: pingMock,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
      persistAndNotify: persist,
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(result.device_id).toBe('dev-1');
    expect(result.primary_reachable).toBe(true);
    expect(result.bmc_creds_valid).toBe(true);
    expect(result.powered_on).toBe(true);
    expect(pingMock).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('one probe fails — other fields still populated', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => false,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(result.bmc_ipmi_reachable).toBe(false);
    expect(result.bmc_icmp_reachable).toBe(true);
    expect(result.bmc_creds_valid).toBe(true);
  });

  it('probe throws → field stays null, others populate', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => {
        throw new Error('boom');
      },
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: false }),
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(result.primary_reachable).toBeNull();
    expect(result.bmc_icmp_reachable).toBeNull();
    expect(result.bmc_ipmi_reachable).toBe(true);
    expect(result.brokkr_live_running).toBe(true);
  });

  it('no bmc_ip skips BMC probes', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    const pingMock = vi.fn(async () => true);
    const ipmiMock = vi.fn(async () => true);
    const rfMock = vi.fn(async () => true);
    const credsMock = vi.fn(async () => ({ creds_valid: true, power_on: true }));
    patchInternalMethods(service, {
      checkPing: pingMock,
      checkIpmiPing: ipmiMock,
      checkRedfishPing: rfMock,
      checkIpmiCreds: credsMock,
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: null,
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(pingMock).toHaveBeenCalledTimes(1);
    expect(ipmiMock).not.toHaveBeenCalled();
    expect(rfMock).not.toHaveBeenCalled();
    expect(credsMock).not.toHaveBeenCalled();
    expect(result.bmc_icmp_reachable).toBeNull();
    expect(result.bmc_creds_valid).toBeNull();
  });

  it('missing creds skips IPMI creds check', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    const credsMock = vi.fn(async () => ({ creds_valid: true, power_on: true }));
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: credsMock,
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: '',
      password: '',
    });
    expect(credsMock).not.toHaveBeenCalled();
    expect(result.bmc_creds_valid).toBeNull();
    expect(result.powered_on).toBeNull();
  });
});

describe('persistAndNotify via checkDeviceHealth', () => {
  it('first observation writes and notifies', async () => {
    const deps = buildDeps({ redisGet: async () => null });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(deps.redis.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = deps.redis.set.mock.calls[0];
    expect(String(key)).toBe('bridge-zone:device-health:dev-1');
    expect(ttl).toBe(RESULT_TTL_SECONDS);
    expect(JSON.parse(String(value)).device_id).toBe('dev-1');
    expect(deps.queueAdd).toHaveBeenCalledTimes(1);
  });

  it('no change skips notify but still writes', async () => {
    const prev = { ...allHealthy(), checked_at: 1_699_999_000 };
    const deps = buildDeps({ redisGet: async () => JSON.stringify(prev) });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(deps.redis.set).toHaveBeenCalledTimes(1);
    expect(deps.queueAdd).not.toHaveBeenCalled();
  });

  it('changed allowlisted field triggers notify', async () => {
    const prev = { ...allHealthy(), powered_on: false };
    const deps = buildDeps({ redisGet: async () => JSON.stringify(prev) });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(deps.queueAdd).toHaveBeenCalledTimes(1);
  });

  it('failed notify does NOT persist the snapshot, so the next check re-detects the change', async () => {
    const prev = { ...allHealthy(), powered_on: false };
    const deps = buildDeps({
      redisGet: async () => JSON.stringify(prev),
      queue: {
        add: vi.fn(async () => {
          throw new Error('queue down');
        }),
      },
    });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(deps.queueAdd).toHaveBeenCalledTimes(1);
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('redis failure is swallowed', async () => {
    const deps = buildDeps({
      redisGet: async () => {
        throw new Error('redis down');
      },
    });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await expect(
      service.checkDeviceHealth({
        deviceId: 'dev-1',
        bmcIp: '10.0.0.1',
        primaryIp: '10.0.0.2',
        username: 'u',
        password: 'p',
      }),
    ).resolves.toBeDefined();
    expect(deps.queueAdd).not.toHaveBeenCalled();
  });
});

describe('sendStateChange payload shape', () => {
  it('enqueues payload without checked_at, with zone_prefix + job_id', async () => {
    const deps = buildDeps({ redisGet: async () => null });
    const service = svc(deps, 'custom-job-42');
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await service.checkDeviceHealth({
      deviceId: 'dev-99',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
      username: 'u',
      password: 'p',
    });
    expect(deps.queueAdd).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = deps.queueAdd.mock.calls[0];
    expect(name).toBe('device_health');
    expect('checked_at' in (payload as object)).toBe(false);
    const p = payload as Record<string, unknown>;
    expect(p.zone_prefix).toBe('bridge-zone');
    expect(p.device_id).toBe('dev-99');
    expect(p.job_id).toBe('custom-job-42');
    expect(p.primary_reachable).toBe(true);
    const o = opts as Record<string, unknown>;
    expect(o.removeOnComplete).toEqual({ count: 1000 });
    expect(o.removeOnFail).toEqual({ count: 100 });
  });

  it('no queue available is a silent no-op', async () => {
    const deps = buildDeps({ queue: null, redisGet: async () => null });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
    });
    await expect(
      service.checkDeviceHealth({
        deviceId: 'dev-1',
        bmcIp: '10.0.0.1',
        primaryIp: '10.0.0.2',
        username: 'u',
        password: 'p',
      }),
    ).resolves.toBeDefined();
    expect(deps.queueAdd).not.toHaveBeenCalled();
  });
});

describe('checkPing via icmpFactory', () => {
  it('returns true when icmpping is 1', async () => {
    const deps = buildDeps({ icmpPing: 1 });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      bmcIp: '10.0.0.1',
      primaryIp: '10.0.0.2',
    });
    expect(result.primary_reachable).toBe(true);
    expect(result.bmc_icmp_reachable).toBe(true);
  });

  it('returns false when icmpping is 0', async () => {
    const deps = buildDeps({ icmpPing: 0 });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({
      deviceId: 'dev-1',
      primaryIp: '10.0.0.2',
    });
    expect(result.primary_reachable).toBe(false);
  });
});

describe('checkBrokkrLive', () => {
  it('connected returns true', async () => {
    const deps = buildDeps({ brokkrConnected: true });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({ deviceId: 'dev-1' });
    expect(result.brokkr_live_running).toBe(true);
  });

  it('not connected returns false', async () => {
    const deps = buildDeps({ brokkrConnected: false });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({ deviceId: 'dev-1' });
    expect(result.brokkr_live_running).toBe(false);
  });

  it('nil device id short-circuits false', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({ deviceId: NIL_DEVICE_ID });
    expect(result.brokkr_live_running).toBe(false);
  });

  it('empty device id short-circuits false', async () => {
    const deps = buildDeps();
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({ deviceId: '' });
    expect(result.brokkr_live_running).toBe(false);
  });

  it('connectivity throws → false', async () => {
    const deps = buildDeps({ brokkrConnThrows: true });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({ deviceId: 'dev-1' });
    expect(result.brokkr_live_running).toBe(false);
  });

  it('factory throws → false', async () => {
    const deps = buildDeps({ brokkrFactoryThrows: true });
    const service = svc(deps);
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkRedfishPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      persistAndNotify: async () => {},
    });
    const result = await service.checkDeviceHealth({ deviceId: 'dev-1' });
    expect(result.brokkr_live_running).toBe(false);
  });
});

describe('createDeviceHealthService factory', () => {
  it('returns a DeviceHealthService instance', async () => {
    const deps = buildDeps();
    const s = await createDeviceHealthService('job-abc', deps);
    expect(s).toBeInstanceOf(DeviceHealthService);
  });
});

describe('checkRedfishPing TLS policy', () => {
  const ENV_KEYS = ['BROKKR_ENV', 'HH_ENV', 'ENVIRONMENT', 'LOCAL_SIMULATION_ENABLED', 'REDFISH_TLS_VERIFY'];
  const savedEnv: Record<string, string | undefined> = {};

  function spyHttpsRequest(capture: { options: https.RequestOptions | null }) {
    const fakeImpl = (
      options: https.RequestOptions,
      callback?: (res: http.IncomingMessage) => void,
    ): http.ClientRequest => {
      capture.options = options;
      const res = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
      res.statusCode = 200;
      res.headers = {};
      queueMicrotask(() => {
        callback?.(res);
        res.end(Buffer.from('{"RedfishVersion":"1.0.0"}', 'utf8'));
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() } as unknown as http.ClientRequest;
    };
    return vi.spyOn(https, 'request').mockImplementation(fakeImpl as typeof https.request);
  }

  function patchAllButRedfish(service: DeviceHealthService): void {
    patchInternalMethods(service, {
      checkPing: async () => true,
      checkIpmiPing: async () => true,
      checkIpmiCreds: async () => ({ creds_valid: true, power_on: true }),
      checkBrokkrLive: async () => true,
      persistAndNotify: async () => {},
    });
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it('does NOT verify TLS certificates by default', async () => {
    const capture: { options: https.RequestOptions | null } = { options: null };
    const spy = spyHttpsRequest(capture);
    const service = svc(buildDeps());
    patchAllButRedfish(service);

    const result = await service.checkDeviceHealth({ deviceId: 'dev-1', bmcIp: '10.0.0.1' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(capture.options).not.toBeNull();
    expect((capture.options as unknown as https.RequestOptions).rejectUnauthorized).toBe(false);
    expect(result.bmc_redfish_reachable).toBe(true);
  });

  it('verifies TLS certificates when REDFISH_TLS_VERIFY=true is opted in', async () => {
    process.env.REDFISH_TLS_VERIFY = 'true';
    const capture: { options: https.RequestOptions | null } = { options: null };
    const spy = spyHttpsRequest(capture);
    const service = svc(buildDeps());
    patchAllButRedfish(service);

    await service.checkDeviceHealth({ deviceId: 'dev-1', bmcIp: '10.0.0.1' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect((capture.options as unknown as https.RequestOptions).rejectUnauthorized).toBe(true);
  });
});
