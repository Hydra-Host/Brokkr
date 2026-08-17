import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { BridgeNetworkModule } from '../../bridge-network/bridge-network.module';
import { ATOM_FETCHER, type AtomFetcher } from '../../bridge-network/netplan-atom.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  IPXE_PENDING_DEVICE_REGISTRAR,
  type PendingDeviceFacts,
  type PendingDeviceRegistrar,
} from '../ipxe.controller';
import { IpxeModule } from '../ipxe.module';

const stubAtomFetcher: AtomFetcher = { getAtom: async () => null };
const placeholderRedis = {} as unknown as RedisService;

@Global()
@Module({
  providers: [
    { provide: ATOM_FETCHER, useValue: stubAtomFetcher },
    { provide: RedisService, useValue: placeholderRedis },
  ],
  exports: [ATOM_FETCHER, RedisService],
})
class TestInfraModule {}

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
  ContextLogger: class {},
}));

function makeFacts(overrides: Partial<PendingDeviceFacts> = {}): PendingDeviceFacts {
  return {
    mac: '00:11:22:33:44:55',
    ip: '10.0.0.42',
    manufacturer: 'Acme',
    ipmi_mac: 'aa:bb:cc:dd:ee:ff',
    ipmi_ip: '10.0.0.43',
    ipmi_tag: 'tag-1',
    serial: 'SN-1',
    board_serial: 'BS-1',
    chassis_serial: 'CS-1',
    system_uuid: 'uuid-1',
    platform: 'discovery',
    buildarch: 'x86_64',
    ...overrides,
  };
}

describe('IpxeModule wiring IPXE_PENDING_DEVICE_REGISTRAR reaches RedisService.hset', () => {
  it('binds a registrar that normalizes MAC and writes discovery:pending hash', async () => {
    const hset = vi.fn(async (_key: string, _mapping: Record<string, string>, _ttl?: number, _jobId?: string) => 1);
    const exists = vi.fn(async (_key: string, _jobId?: string) => true);
    const redisStub = { hset, exists } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestInfraModule,
        BridgeNetworkModule.forRoot(),
        IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
      ],
    })
      .overrideProvider(RedisService)
      .useValue(redisStub)
      .compile();

    const registrar = moduleRef.get<PendingDeviceRegistrar>(IPXE_PENDING_DEVICE_REGISTRAR);
    expect(typeof registrar).toBe('function');

    const confirmed = await registrar('wiring-job-id', makeFacts({ mac: '00-11-22-33-44-55' }));
    expect(confirmed).toBe(true);

    expect(hset).toHaveBeenCalledTimes(1);
    const call = hset.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [key, mapping, ttl, jobId] = call;
    expect(key).toBe('discovery:pending:00:11:22:33:44:55');
    expect(mapping.mac).toBe('00:11:22:33:44:55');
    expect(mapping.platform).toBe('discovery');
    expect(ttl).toBe(2592000);
    expect(jobId).toBe('wiring-job-id');

    expect(exists).not.toHaveBeenCalled();

    await moduleRef.close();
  });

  it('keys the pending hash on the system_uuid fallback when MAC is empty', async () => {
    const hset = vi.fn(async (_key: string, _mapping: Record<string, string>, _ttl?: number, _jobId?: string) => 1);
    const redisStub = { hset } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestInfraModule,
        BridgeNetworkModule.forRoot(),
        IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
      ],
    })
      .overrideProvider(RedisService)
      .useValue(redisStub)
      .compile();

    const registrar = moduleRef.get<PendingDeviceRegistrar>(IPXE_PENDING_DEVICE_REGISTRAR);
    await registrar('wiring-job-id', makeFacts({ mac: '' }));

    expect(hset).toHaveBeenCalledTimes(1);
    const call = hset.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [key, , ttl, jobId] = call;
    expect(key).toBe('discovery:pending:uuid-1');
    expect(ttl).toBe(2592000);
    expect(jobId).toBe('wiring-job-id');
    await moduleRef.close();
  });

  it('skips hset when MAC is empty and no fallback identifier is present', async () => {
    const hset = vi.fn(async (_key: string, _mapping: Record<string, string>, _ttl?: number, _jobId?: string) => 1);
    const redisStub = { hset } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestInfraModule,
        BridgeNetworkModule.forRoot(),
        IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
      ],
    })
      .overrideProvider(RedisService)
      .useValue(redisStub)
      .compile();

    const registrar = moduleRef.get<PendingDeviceRegistrar>(IPXE_PENDING_DEVICE_REGISTRAR);
    const confirmed = await registrar('wiring-job-id', makeFacts({ mac: '', system_uuid: '', serial: '' }));

    expect(hset).not.toHaveBeenCalled();
    expect(confirmed).toBe(false);
    await moduleRef.close();
  });

  it('PXE-05: keys the discovery:pending hash on system_uuid when MAC is empty', async () => {
    const hset = vi.fn(async (_key: string, _mapping: Record<string, string>, _ttl?: number, _jobId?: string) => 1);
    const redisStub = { hset } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestInfraModule,
        BridgeNetworkModule.forRoot(),
        IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
      ],
    })
      .overrideProvider(RedisService)
      .useValue(redisStub)
      .compile();

    const registrar = moduleRef.get<PendingDeviceRegistrar>(IPXE_PENDING_DEVICE_REGISTRAR);
    const confirmed = await registrar('wiring-job-id', makeFacts({ mac: '', system_uuid: 'UUID-7' }));

    expect(confirmed).toBe(true);
    expect(hset).toHaveBeenCalledTimes(1);
    const [key] = hset.mock.calls[0] ?? [];
    expect(key).toBe('discovery:pending:uuid-7');
    await moduleRef.close();
  });

  it('bugbot 99eadb9f: a swallowed write failure reports unconfirmed despite a leftover key', async () => {
    const hset = vi.fn(async () => {
      throw new Error('redis down');
    });
    const exists = vi.fn(async (_key: string, _jobId?: string) => true);
    const redisStub = { hset, exists } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestInfraModule,
        BridgeNetworkModule.forRoot(),
        IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
      ],
    })
      .overrideProvider(RedisService)
      .useValue(redisStub)
      .compile();

    const registrar = moduleRef.get<PendingDeviceRegistrar>(IPXE_PENDING_DEVICE_REGISTRAR);
    const confirmed = await registrar('wiring-job-id', makeFacts({ mac: '00:11:22:33:44:55' }));

    expect(hset).toHaveBeenCalledTimes(1);
    expect(confirmed).toBe(false);
    expect(exists).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
