
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { BridgeNetworkModule } from '../../bridge-network/bridge-network.module';
import { ATOM_FETCHER, type AtomFetcher } from '../../bridge-network/netplan-atom.service';
import { RedisService } from '../../common/redis/redis.service';
import type { EnqueueRenderRequest } from '../../device-record/atom/atom-fetcher';
import { DeviceRecordService, ResolveOutcome } from '../../device-record/device-record.service';

import { IpxeModule } from '../ipxe.module';

const stubAtomFetcher: AtomFetcher = { getAtom: async () => null };
const stubRedis = { get: async () => null, delete: async () => 0 } as unknown as RedisService;

@Global()
@Module({
  providers: [
    { provide: ATOM_FETCHER, useValue: stubAtomFetcher },
    { provide: RedisService, useValue: stubRedis },
  ],
  exports: [ATOM_FETCHER, RedisService],
})
class TestInfraModule {}

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
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

describe('IpxeModule wiring render-request enqueuer reaches DeviceRecordService', () => {
  it('cold-cache identifier resolution triggers the supplied enqueueRenderRequest', async () => {
    const enqueueRenderRequest = vi.fn<EnqueueRenderRequest>(async () => true);

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfraModule, BridgeNetworkModule.forRoot(), IpxeModule.forRoot({ enqueueRenderRequest })],
    })
      .overrideProvider(RedisService)
      .useValue(stubRedis)
      .compile();

    const deviceRecord = moduleRef.get(DeviceRecordService);

    const outcome = await deviceRecord.resolveDevice(
      { mac: '00:11:22:33:44:55' },
      { jobId: 'wiring-test-job', timeoutS: 0, pollIntervalS: 0 },
    );

    expect(outcome).toBe(ResolveOutcome.UNKNOWN);
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
    const call = enqueueRenderRequest.mock.calls[0]?.[0];
    expect(call?.domain).toBe('device_record');
    expect(call?.params).toMatchObject({
      identifiers: { mac: '00:11:22:33:44:55' },
    });

    await moduleRef.close();
  });
});
