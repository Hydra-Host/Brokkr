import { describe, expect, it, vi, type Mock } from 'vitest';

import { RedisOperationError } from '../../common/redis/redis-client';
import type { DeviceRecord } from '../../device-record/device-record.schema';
import { deviceRecordSchema } from '../../device-record/device-record.schema';
import type { NetplanAtom } from '../../device-record/netplan/netplan.schema';
import { netplanAtomSchema } from '../../device-record/netplan/netplan.schema';
import {
  DeviceService,
  DeviceServiceError,
  DeviceServiceTransientError,
  DeviceValidationError,
  type AtomFetcherLike,
  type DeviceData,
  type DeviceServiceCache,
  type DeviceServiceDeps,
  type GetAtomParams,
  type GetLiveNetplanFn,
} from '../device.service';

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return deviceRecordSchema.parse({ id: overrides.id ?? 'unset', ...overrides });
}

interface ServiceFixture {
  service: DeviceService;
  cache: DeviceServiceCache & { hset: Mock<(...args: any[]) => any> };
  atomFetcher: AtomFetcherLike & {
    getAtom: Mock<(...args: any[]) => any>;
    readAtom: Mock<(...args: any[]) => any>;
  };
  getLiveNetplan: Mock<(...args: any[]) => any>;
}

function makeService(
  opts: {
    jobId?: string;
    getAtomImpl?: <T>(params: GetAtomParams<T>) => Promise<T | null>;
    readAtomImpl?: <T>(key: string, valueSchema: GetAtomParams<T>['valueSchema'], jobId?: string) => Promise<T | null>;
    liveNetplan?: GetLiveNetplanFn;
    hsetImpl?: DeviceServiceCache['hset'];
  } = {},
): ServiceFixture {
  const getAtom = vi.fn(opts.getAtomImpl ?? (async <T>(_p: GetAtomParams<T>): Promise<T | null> => null));
  const readAtom = vi.fn(opts.readAtomImpl ?? (async <T>(): Promise<T | null> => null));
  const liveNetplan = vi.fn<GetLiveNetplanFn>(opts.liveNetplan ?? (async (): Promise<string | null> => null));
  const hset = vi.fn<DeviceServiceCache['hset']>(opts.hsetImpl ?? (async () => 0));

  const atomFetcher = {
    getAtom: getAtom as unknown as AtomFetcherLike['getAtom'],
    readAtom: readAtom as unknown as AtomFetcherLike['readAtom'],
  };
  const cache: DeviceServiceCache = { hset };
  const deps: DeviceServiceDeps = {
    cache,
    atomFetcher,
    getLiveNetplan: liveNetplan,
  };
  const service = new DeviceService(opts.jobId ?? 'test-job', deps);
  return {
    service,
    cache: cache as ServiceFixture['cache'],
    atomFetcher: atomFetcher as ServiceFixture['atomFetcher'],
    getLiveNetplan: liveNetplan,
  };
}

describe('DeviceService — initialization + MAC validation', () => {
  it('exposes jobId on the instance', () => {
    const { service } = makeService({ jobId: 'test-job' });
    expect(service.jobId).toBe('test-job');
  });

  it('accepts valid MAC formats (colon + dash, mixed case)', () => {
    const { service } = makeService();
    const validMacs = [
      '00:11:22:33:44:55',
      'AA:BB:CC:DD:EE:FF',
      'aa:bb:cc:dd:ee:ff',
      '00-11-22-33-44-55',
      'AA-BB-CC-DD-EE-FF',
    ];
    for (const mac of validMacs) {
      expect(service.isValidMac(mac)).toBe(true);
    }
  });

  it('rejects malformed MACs', () => {
    const { service } = makeService();
    const invalidMacs = [
      '00:11:22:33:44',
      '00:11:22:33:44:55:66',
      '00:11:22:33:44:GG',
      '00-11-22:33:44:55',
      'invalid-mac',
      '',
      '00:11:22:33:44:555',
    ];
    for (const mac of invalidMacs) {
      expect(service.isValidMac(mac)).toBe(false);
    }
  });
});

describe('DeviceService.getDeviceById', () => {
  it('reads the device_record atom and returns its flat dict', async () => {
    const deviceId = '66666666-6666-6666-6666-666666666666';
    const rec = record({
      id: deviceId,
      status: 'active',
      role: 'server',
      netplan: 'network:\n  version: 2\n',
    });
    const { service, atomFetcher } = makeService({
      getAtomImpl: async (_p) => rec as unknown as null,
    });

    const result = await service.getDeviceById(deviceId, true);

    expect(result['id']).toBe(deviceId);
    expect(result['status']).toBe('active');
    expect(result['role']).toBe('server');
    const callArgs = atomFetcher.getAtom.mock.calls[0][0] as GetAtomParams<unknown>;
    expect(callArgs.domain).toBe('device_record');
    expect(callArgs.entityId).toBe(deviceId);
  });

  it('returns {} when the device_record atom is missing', async () => {
    const { service } = makeService();
    const result = await service.getDeviceById('404', true);
    expect(result).toEqual({});
  });

  it('throws DeviceValidationError on empty deviceId', async () => {
    const { service } = makeService();
    await expect(service.getDeviceById('')).rejects.toBeInstanceOf(DeviceValidationError);
    await expect(service.getDeviceById('')).rejects.toThrow(/Device ID cannot be empty/);
  });
});

describe('DeviceService.normalizeNetplanYaml', () => {
  it('returns normalized yaml for valid input', () => {
    const { service } = makeService();
    const messy = 'network:\n  version: 2\n  ethernets:\n      eth0:\n        dhcp4: true';
    const result = service.normalizeNetplanYaml(messy);
    expect(result).not.toBeNull();
    expect(result!).toContain('eth0');
    expect(result!).toContain('dhcp4: true');
  });

  it('returns null for invalid yaml', () => {
    const { service } = makeService();
    expect(service.normalizeNetplanYaml('invalid: yaml: [')).toBeNull();
  });

  it('returns null for empty string', () => {
    const { service } = makeService();
    expect(service.normalizeNetplanYaml('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    const { service } = makeService();
    expect(service.normalizeNetplanYaml('   \n  \n')).toBeNull();
  });
});

describe('DeviceService.fetchNetplanFromRedis', () => {
  function buildAtom(yaml: string): NetplanAtom {
    return netplanAtomSchema.parse({ yaml });
  }

  it('returns the live yaml when the atom is present', async () => {
    const yaml = 'network:\n  version: 2\n';
    const { service, atomFetcher } = makeService({
      readAtomImpl: async () => buildAtom(yaml) as unknown as null,
    });
    const result = await service.fetchNetplanFromRedis('42', 'live');
    expect(result).toBe(yaml);
    expect(atomFetcher.readAtom).toHaveBeenCalledTimes(1);
    const args = atomFetcher.readAtom.mock.calls[0];
    expect(args[0]).toBe('device:42:config:netplan:live');
    expect(args[1]).toBe(netplanAtomSchema);
  });

  it('returns the deploy yaml when the deploy atom is present', async () => {
    const yaml = 'network: {version: 2}';
    const { service, atomFetcher } = makeService({
      readAtomImpl: async () => buildAtom(yaml) as unknown as null,
    });
    const result = await service.fetchNetplanFromRedis('42', 'deploy');
    expect(result).toBe(yaml);
    const args = atomFetcher.readAtom.mock.calls[0];
    expect(args[0]).toBe('device:42:config:netplan:deploy');
  });

  it('returns null on a Redis miss', async () => {
    const { service } = makeService();
    expect(await service.fetchNetplanFromRedis('42', 'live')).toBeNull();
  });

  it('propagates RedisOperationError so callers can distinguish unreachable from miss', async () => {
    const { service } = makeService({
      readAtomImpl: async () => {
        throw new RedisOperationError('connection refused');
      },
    });
    await expect(service.fetchNetplanFromRedis('42', 'live')).rejects.toBeInstanceOf(RedisOperationError);
    await expect(service.fetchNetplanFromRedis('42', 'live')).rejects.toThrow(/connection refused/);
  });

  it('degrades to null on an unexpected (non-RedisOperationError) failure', async () => {
    const { service } = makeService({
      readAtomImpl: async () => {
        throw new Error('bug in cache impl');
      },
    });
    expect(await service.fetchNetplanFromRedis('42', 'live')).toBeNull();
  });

  it('rejects an invalid phase', async () => {
    const { service } = makeService();
    await expect(service.fetchNetplanFromRedis('42', 'bogus')).rejects.toThrow(/phase/);
  });
});

describe('DeviceService.validateNetplanPhase', () => {
  it('accepts live', () => {
    const { service } = makeService();
    expect(() => service.validateNetplanPhase('live')).not.toThrow();
  });

  it('accepts deploy', () => {
    const { service } = makeService();
    expect(() => service.validateNetplanPhase('deploy')).not.toThrow();
  });

  it('rejects unknown phase', () => {
    const { service } = makeService();
    expect(() => service.validateNetplanPhase('bogus')).toThrow(/netplan_phase must be one of/);
  });

  it('rejects empty string', () => {
    const { service } = makeService();
    expect(() => service.validateNetplanPhase('')).toThrow(/netplan_phase must be one of/);
  });
});

describe('DeviceService.applyNetplanResolution — Redis tier', () => {
  const NON_VPC_ID = '55555555-5555-5555-5555-555555555555';

  function nonVpcDevice(extra: DeviceData = {}): DeviceData {
    return { id: NON_VPC_ID, is_vpc: false, interfaces: [], ...extra };
  }

  function vpcDevice(extra: DeviceData = {}): DeviceData {
    return { id: NON_VPC_ID, is_vpc: true, interfaces: [], ...extra };
  }

  function spyOnFetch(service: DeviceService, fn: (id: string, phase: string) => Promise<string | null>) {
    return vi.spyOn(service, 'fetchNetplanFromRedis').mockImplementation(fn);
  }

  it('non-VPC live: Redis hit short-circuits render-on-miss', async () => {
    const yaml = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n';
    const { service, getLiveNetplan } = makeService();
    spyOnFetch(service, async () => yaml);

    const result = await service.applyNetplanResolution(nonVpcDevice(), 'live');

    expect(result['netplan'] as string).toContain('eth0');
    expect(getLiveNetplan).not.toHaveBeenCalled();
  });

  it('non-VPC live: Redis miss falls through to render-on-miss', async () => {
    const rendered = 'network:\n  version: 2\n  ethernets:\n    eno1:\n      dhcp4: true\n';
    const { service } = makeService({ liveNetplan: async () => rendered });
    spyOnFetch(service, async () => null);

    const result = await service.applyNetplanResolution(nonVpcDevice(), 'live');

    expect(result['netplan'] as string).toContain('eno1');
  });

  it('non-VPC live: invalid Redis yaml falls through to render-on-miss', async () => {
    const rendered = 'network:\n  version: 2\n  ethernets:\n    eno1:\n      dhcp4: true\n';
    const { service } = makeService({ liveNetplan: async () => rendered });
    spyOnFetch(service, async () => 'not: valid: yaml: [');

    const result = await service.applyNetplanResolution(nonVpcDevice(), 'live');

    expect(result['netplan'] as string).toContain('eno1');
  });

  it('VPC live: Redis hit short-circuits render-on-miss', async () => {
    const yaml = 'network:\n  version: 2\n  ethernets:\n    bond0:\n      dhcp4: true\n';
    const { service } = makeService();
    spyOnFetch(service, async () => yaml);

    const result = await service.applyNetplanResolution(vpcDevice(), 'live');

    expect(result['netplan'] as string).toContain('bond0');
  });

  it('VPC live: Redis miss falls through to render-on-miss', async () => {
    const rendered = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n';
    const { service } = makeService({ liveNetplan: async () => rendered });
    spyOnFetch(service, async () => null);

    const result = await service.applyNetplanResolution(vpcDevice(), 'live');

    expect(result['netplan'] as string).toContain('eth0');
  });

  it('VPC deploy: Redis hit short-circuits render-on-miss', async () => {
    const yaml = 'network:\n  version: 2\n  ethernets:\n    provision0:\n      dhcp4: true\n';
    const { service } = makeService();
    spyOnFetch(service, async () => yaml);

    const result = await service.applyNetplanResolution(vpcDevice(), 'deploy');

    expect(result['netplan'] as string).toContain('provision0');
  });

  it('VPC deploy: Redis miss hard-fails', async () => {
    const { service } = makeService();
    spyOnFetch(service, async () => null);

    await expect(service.applyNetplanResolution(vpcDevice(), 'deploy')).rejects.toBeInstanceOf(DeviceServiceError);
    await expect(service.applyNetplanResolution(vpcDevice(), 'deploy')).rejects.toThrow(/missing :deploy netplan/);
  });

  it('VPC deploy: parseable-but-invalid Redis content hard-fails', async () => {
    const { service } = makeService();
    spyOnFetch(service, async () => 'not: valid: yaml: [');

    await expect(service.applyNetplanResolution(vpcDevice(), 'deploy')).rejects.toThrow(/invalid :deploy netplan/);
  });

  it('non-VPC deploy: still reads :live (single netplan for non-VPC)', async () => {
    let capturedPhase = '';
    const { service } = makeService();
    spyOnFetch(service, async (_id, phase) => {
      capturedPhase = phase;
      return 'network:\n  version: 2\n';
    });

    await service.applyNetplanResolution(nonVpcDevice(), 'deploy');
    expect(capturedPhase).toBe('live');
  });

  it('device lacking an id skips Redis and falls through to the existing netplan', async () => {
    const dev: DeviceData = {
      is_vpc: true,
      interfaces: [],
      netplan: 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n',
    };
    const { service } = makeService();
    const fetchSpy = spyOnFetch(service, async () => null);

    const result = await service.applyNetplanResolution(dev, 'deploy');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result['netplan'] as string).toContain('eth0');
  });

  it('VPC deploy + Redis transient error raises DeviceServiceTransientError', async () => {
    const { service } = makeService();
    spyOnFetch(service, async () => {
      throw new RedisOperationError('connection refused');
    });

    await expect(service.applyNetplanResolution(vpcDevice(), 'deploy')).rejects.toBeInstanceOf(
      DeviceServiceTransientError,
    );
    await expect(service.applyNetplanResolution(vpcDevice(), 'deploy')).rejects.toThrow(/Redis unavailable/);
  });

  it('VPC deploy transient error is a DeviceServiceError subclass', async () => {
    const { service } = makeService();
    spyOnFetch(service, async () => {
      throw new RedisOperationError('connection refused');
    });
    await expect(service.applyNetplanResolution(vpcDevice(), 'deploy')).rejects.toBeInstanceOf(DeviceServiceError);
  });

  it('VPC live + Redis error falls through to render-on-miss', async () => {
    const rendered = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n';
    const { service } = makeService({ liveNetplan: async () => rendered });
    spyOnFetch(service, async () => {
      throw new RedisOperationError('connection refused');
    });

    const result = await service.applyNetplanResolution(vpcDevice(), 'live');
    expect(result['netplan'] as string).toContain('eth0');
  });

  it('non-VPC Redis error falls through to render-on-miss', async () => {
    const rendered = 'network:\n  version: 2\n  ethernets:\n    eno1:\n      dhcp4: true\n';
    const { service } = makeService({ liveNetplan: async () => rendered });
    spyOnFetch(service, async () => {
      throw new RedisOperationError('connection refused');
    });

    const result = await service.applyNetplanResolution(nonVpcDevice(), 'deploy');
    expect(result['netplan'] as string).toContain('eno1');
  });

  it('live tier uses render-on-miss when Redis returns null', async () => {
    const rendered = 'network:\n  version: 2\n  ethernets:\n    rendered0:\n      dhcp4: true\n';
    const { service, getLiveNetplan } = makeService({ liveNetplan: async () => rendered });
    spyOnFetch(service, async () => null);

    const result = await service.applyNetplanResolution(
      { id: '77777777-7777-7777-7777-777777777777', location_network_type: 'dedicated', interfaces: [] },
      'live',
    );

    expect(result['netplan'] as string).toContain('rendered0');
    expect(getLiveNetplan).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceService.getDeviceById — phase threading + netplan resolution', () => {
  it('accepts both valid phases', async () => {
    const deviceId = '88888888-8888-8888-8888-888888888888';
    const rec = record({ id: deviceId });
    const { service } = makeService({
      getAtomImpl: async () => rec as unknown as null,
    });
    await expect(service.getDeviceById(deviceId, true, 'live')).resolves.toBeDefined();
    await expect(service.getDeviceById(deviceId, true, 'deploy')).resolves.toBeDefined();
  });

  it('rejects invalid phase', async () => {
    const { service } = makeService();
    await expect(service.getDeviceById('1', true, 'bogus')).rejects.toThrow(/phase/);
  });

  it('skipNetplan=true returns the atom dict untouched', async () => {
    const deviceId = '88888888-8888-8888-8888-888888888888';
    const rec = record({ id: deviceId });
    const { service } = makeService({
      getAtomImpl: async () => rec as unknown as null,
    });
    const result = await service.getDeviceById(deviceId, true, 'live');
    expect(result['id']).toBe(deviceId);
    expect(result['netplan'] ?? null).toBeNull();
  });

  it('non-VPC deploy caller reads :live from Redis (deploy coerced for non-VPC)', async () => {
    const deviceId = '99999999-9999-9999-9999-999999999999';
    const rec = record({ id: deviceId, netplan: 'network:\n  version: 2\n' });
    const liveYaml = 'network:\n  version: 2\n  ethernets:\n    live0:\n      dhcp4: true\n';
    const { service } = makeService({
      getAtomImpl: async () => rec as unknown as null,
    });
    const fetchSpy = vi.spyOn(service, 'fetchNetplanFromRedis').mockResolvedValue(liveYaml);

    const result = await service.getDeviceById(deviceId, false, 'deploy');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toBe('live');
    expect(result['netplan'] as string).toContain('live0');
  });

  it("role='discovered-hosts' skips the Redis netplan tier", async () => {
    const deviceId = '99999999-9999-9999-9999-999999999999';
    const rec = record({ id: deviceId, role: 'discovered-hosts', netplan: null });
    const { service } = makeService({
      getAtomImpl: async () => rec as unknown as null,
    });
    const fetchSpy = vi.spyOn(service, 'fetchNetplanFromRedis').mockResolvedValue(null);

    const result = await service.getDeviceById(deviceId, false, 'live');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result['netplan'] as string).toContain('dhcp4');
  });

  it('skipNetplan=true bypasses Redis netplan resolution entirely', async () => {
    const deviceId = '99999999-9999-9999-9999-999999999999';
    const rec = record({ id: deviceId, netplan: 'atom-yaml' });
    const { service } = makeService({
      getAtomImpl: async () => rec as unknown as null,
    });
    const fetchSpy = vi.spyOn(service, 'fetchNetplanFromRedis');

    const result = await service.getDeviceById(deviceId, true, 'live');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result['netplan']).toBe('atom-yaml');
  });
});

describe('DeviceService.registerPendingDevice', () => {
  it('normalizes MAC + filters empty/None values into the hset mapping', async () => {
    const { service, cache } = makeService();
    const confirmed = await service.registerPendingDevice({
      mac: '00-11-22-33-44-55',
      ip: '10.0.0.42',
      manufacturer: 'Acme',
      ipmi_mac: null,
      serial: '',
    });

    expect(confirmed).toBe(true);
    expect(cache.hset).toHaveBeenCalledTimes(1);
    const [key, mapping, ttl] = cache.hset.mock.calls[0];
    expect(key).toBe('discovery:pending:00:11:22:33:44:55');
    expect(mapping['mac']).toBe('00:11:22:33:44:55');
    expect(mapping['ip']).toBe('10.0.0.42');
    expect(mapping['manufacturer']).toBe('Acme');
    expect(mapping['ipmi_mac']).toBeUndefined();
    expect(mapping['serial']).toBeUndefined();
    expect(ttl).toBe(2592000);
  });

  it('skips entirely and reports false when MAC and all fallbacks are empty', async () => {
    const { service, cache } = makeService();
    const confirmed = await service.registerPendingDevice({ mac: '', ip: '10.0.0.42' });
    expect(confirmed).toBe(false);
    expect(cache.hset).not.toHaveBeenCalled();
  });

  it('PXE-05: keys on system_uuid when MAC is empty', async () => {
    const { service, cache } = makeService();
    const confirmed = await service.registerPendingDevice({
      mac: '',
      system_uuid: '4C4C4544-0042-4D10-8042-B8C04F303233',
      serial: 'SN-1',
      manufacturer: 'Dell',
    });

    expect(confirmed).toBe(true);
    expect(cache.hset).toHaveBeenCalledTimes(1);
    const [key, mapping] = cache.hset.mock.calls[0];
    expect(key).toBe('discovery:pending:4c4c4544-0042-4d10-8042-b8c04f303233');
    expect(mapping['mac']).toBeUndefined();
    expect(mapping['system_uuid']).toBe('4C4C4544-0042-4D10-8042-B8C04F303233');
    expect(mapping['manufacturer']).toBe('Dell');
  });

  it('PXE-05: falls back to serial when MAC and system_uuid are empty', async () => {
    const { service, cache } = makeService();
    const confirmed = await service.registerPendingDevice({ mac: '', system_uuid: '', serial: 'SN-XYZ-1' });

    expect(confirmed).toBe(true);
    const [key] = cache.hset.mock.calls[0];
    expect(key).toBe('discovery:pending:sn-xyz-1');
  });

  it('PXE-05: sanitizes a hostile serial (spaces, colons) into a safe key segment', async () => {
    const { service, cache } = makeService();
    const confirmed = await service.registerPendingDevice({
      mac: '',
      system_uuid: '',
      serial: 'Dell Inc.: SN 12:34',
    });

    expect(confirmed).toBe(true);
    const [key] = cache.hset.mock.calls[0];
    expect(key).toBe('discovery:pending:dell-inc-sn-12-34');
  });

  it('PXE-05: returns false when no identifier sanitizes to a usable segment', async () => {
    const { service, cache } = makeService();
    const confirmed = await service.registerPendingDevice({ mac: '', system_uuid: '', serial: ':: ::' });
    expect(confirmed).toBe(false);
    expect(cache.hset).not.toHaveBeenCalled();
  });

  it('bugbot 99eadb9f: a swallowed cache exception reports false, never a fake true', async () => {
    const { service } = makeService({
      hsetImpl: async () => {
        throw new Error('Redis down');
      },
    });
    await expect(service.registerPendingDevice({ mac: '00:11:22:33:44:55' })).resolves.toBe(false);
  });
});
