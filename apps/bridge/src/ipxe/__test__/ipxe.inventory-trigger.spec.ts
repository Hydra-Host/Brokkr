import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeNetworkModule } from '../../bridge-network/bridge-network.module';
import { ATOM_FETCHER, type AtomFetcher } from '../../bridge-network/netplan-atom.service';
import { openBridgeLocalJob } from '../../bullmq/bridge-local-sig';
import { getBullmqConfig, resetBullmqConfigForTests } from '../../bullmq/bullmq.config';
import { JOB_NAME } from '../../bullmq/bullmq.types';
import {
  BULLMQ_QUEUE_FACTORY,
  type BullmqQueue,
  type BullmqQueueFactory,
  type JobAddOptions,
  type SharedOpsClient,
} from '../../bullmq/queue.service';
import { RedisService } from '../../common/redis/redis.service';
import { PLAN_PERSISTER_PROVIDER } from '../../saga-framework/plan-manager-holder';
import { ZoneCryptoService } from '../../zone-crypto/zone-crypto.service';

import { IPXE_INVENTORY_TRIGGER, type InventoryTrigger } from '../chain.service';
import { IpxeModule } from '../ipxe.module';

const stubAtomFetcher: AtomFetcher = { getAtom: async () => null };
const stubRedis = { get: async () => null, delete: async () => 0 } as unknown as RedisService;
const persistInitialPlan = vi.fn(async () => true);

@Global()
@Module({
  providers: [
    { provide: ATOM_FETCHER, useValue: stubAtomFetcher },
    { provide: RedisService, useValue: stubRedis },
    { provide: PLAN_PERSISTER_PROVIDER, useValue: () => ({ persistInitialPlan }) },
  ],
  exports: [ATOM_FETCHER, RedisService, PLAN_PERSISTER_PROVIDER],
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

class FakeQueue implements BullmqQueue {
  readonly added: Array<{ data: Record<string, unknown>; opts: JobAddOptions }> = [];

  async add(_name: string, data: Record<string, unknown>, opts: JobAddOptions): Promise<unknown> {
    this.added.push({ data, opts });
    return {};
  }

  async remove(): Promise<void> {}

  async getJobState(): Promise<string | null> {
    return null;
  }

  async close(): Promise<void> {}
}

const ZONE_PRIV = Buffer.alloc(32, 1);

describe('IpxeModule wiring IPXE_INVENTORY_TRIGGER seals bridge-local jobs', () => {
  beforeEach(() => {
    resetBullmqConfigForTests();
  });

  afterEach(() => {
    new ZoneCryptoService().clear();
  });

  it('enqueues a sealed envelope, not a bare bridge-local flag, when the zone is activated', async () => {
    const queue = new FakeQueue();
    const client: SharedOpsClient = { aclose: async () => {} };
    const factory: BullmqQueueFactory = {
      createSharedOpsClient: () => client,
      createQueue: () => queue,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestInfraModule,
        BridgeNetworkModule.forRoot(),
        IpxeModule.forRoot({ enqueueRenderRequest: async () => true }),
      ],
    })
      .overrideProvider(RedisService)
      .useValue(stubRedis)
      .overrideProvider(BULLMQ_QUEUE_FACTORY)
      .useValue(factory)
      .compile();

    new ZoneCryptoService().set({
      zonePriv: ZONE_PRIV,
      zonePub: Buffer.alloc(32, 2),
      hubPub: Buffer.alloc(32, 3),
      enrolledAt: Date.now(),
    });

    const trigger = moduleRef.get<InventoryTrigger>(IPXE_INVENTORY_TRIGGER);
    await trigger('device-1', 'job-1');

    expect(persistInitialPlan).toHaveBeenCalledWith(
      expect.any(String),
      'inventory_collection',
      'device-1',
      expect.any(String),
    );
    expect(queue.added).toHaveLength(1);
    const { data, opts } = queue.added[0];
    expect(data.__bridge_local).toBe(true);
    expect(data.__bridge_local_ts).toMatch(/^\d+$/);
    expect(data.__bridge_local_sig).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof data.__bridge_local_nonce).toBe('string');
    expect(typeof data.__bridge_local_ciphertext).toBe('string');
    expect(typeof data.__bridge_local_tag).toBe('string');
    expect(data).not.toHaveProperty('payload');
    expect(data).not.toHaveProperty('plan_id');

    const opened = openBridgeLocalJob(ZONE_PRIV, data, {
      job_id: opts.jobId,
      job_name: JOB_NAME.SAGA_RUN,
      queue_name: getBullmqConfig().bullmqQueueName,
    });
    expect(opened).toMatchObject({
      saga_name: 'inventory_collection',
      device_id: 'device-1',
      payload: { device_id: 'device-1' },
    });

    await moduleRef.close();
  });
});
