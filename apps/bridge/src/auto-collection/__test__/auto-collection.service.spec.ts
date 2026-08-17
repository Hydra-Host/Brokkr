import { describe, expect, it, vi, type Mock } from 'vitest';

import { NIL_DEVICE_ID } from '../../common/redis/redis-keys';
import { type DeviceRecord } from '../../device-record/device-record.schema';
import {
  AutoCollectionService,
  COOLDOWN_BOOTSTRAP_S,
  COOLDOWN_REFRESH_S,
  sagaLockKey,
  type AutoCollectionCache,
  type AutoCollectionLogger,
  type EnqueueCollectionJob,
  type ReadAtom,
} from '../auto-collection.service';

const SILENT_LOGGER: AutoCollectionLogger = {
  debug: async () => {},
  info: async () => {},
  warning: async () => {},
};

const DEV = '11111111-1111-1111-1111-111111111111';

interface MockOptions {
  lockHeld?: boolean;
  record?: DeviceRecord | null;
  setNxAcquired?: boolean;
  enqueueReturn?: boolean;
  enqueueRaises?: Error;
  existsRaises?: Error;
}

function buildHarness(opts: MockOptions = {}) {
  const cache: AutoCollectionCache = {
    exists: vi.fn(async () => {
      if (opts.existsRaises) throw opts.existsRaises;
      return opts.lockHeld ?? false;
    }),
    get: vi.fn(async () => null),
    setNxOwned: vi.fn(async () => opts.setNxAcquired ?? true),
    delete: vi.fn(async () => 1),
  };
  const readAtom: ReadAtom = vi.fn(async () => (opts.record ?? null) as never);
  const enqueueCollectionJob: EnqueueCollectionJob = vi.fn(async () => {
    if (opts.enqueueRaises) throw opts.enqueueRaises;
    return opts.enqueueReturn ?? true;
  });
  const service = new AutoCollectionService(cache, enqueueCollectionJob, readAtom, SILENT_LOGGER);
  return { service, cache, readAtom, enqueueCollectionJob };
}

describe('AutoCollectionService.maybeEnqueueCollectionOnRegister', () => {
  it('skips nil device id', async () => {
    const { service, enqueueCollectionJob } = buildHarness();
    await service.maybeEnqueueCollectionOnRegister(NIL_DEVICE_ID);
    expect(enqueueCollectionJob).not.toHaveBeenCalled();
  });

  it('skips when saga lock held', async () => {
    const { service, readAtom, enqueueCollectionJob } = buildHarness({ lockHeld: true });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(enqueueCollectionJob).not.toHaveBeenCalled();
    expect(readAtom).not.toHaveBeenCalled();
  });

  it('skips when cooldown active', async () => {
    const { service, enqueueCollectionJob } = buildHarness({
      setNxAcquired: false,
      record: null,
    });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(enqueueCollectionJob).not.toHaveBeenCalled();
  });

  it('bootstrap cooldown when record missing', async () => {
    const { service, cache, enqueueCollectionJob } = buildHarness({ record: null });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(enqueueCollectionJob).toHaveBeenCalledTimes(1);
    expect(cache.setNxOwned).toHaveBeenCalledTimes(1);
    const setNxArgs = (cache.setNxOwned as Mock<(...args: any[]) => any>).mock.calls[0];
    expect(setNxArgs[2]).toBe(COOLDOWN_BOOTSTRAP_S);
  });

  it('bootstrap cooldown when record is placeholder', async () => {
    const placeholder: DeviceRecord = {
      id: DEV,
      is_placeholder: true,
      status: null,
      role: null,
      installed_os: null,
      rescue_os: null,
      platform_tags: [],
      device_type: null,
      netplan: null,
      serial_port_recommended: null,
      location_network_type: null,
      is_vpc: false,
      last_job_id: null,
      buildarch: null,
    };
    const { service, cache, enqueueCollectionJob } = buildHarness({ record: placeholder });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(enqueueCollectionJob).toHaveBeenCalledTimes(1);
    const setNxArgs = (cache.setNxOwned as Mock<(...args: any[]) => any>).mock.calls[0];
    expect(setNxArgs[2]).toBe(COOLDOWN_BOOTSTRAP_S);
  });

  it('refresh cooldown when record healthy', async () => {
    const healthy: DeviceRecord = {
      id: DEV,
      is_placeholder: false,
      status: 'INVENTORY',
      role: null,
      installed_os: null,
      rescue_os: null,
      platform_tags: [],
      device_type: null,
      netplan: null,
      serial_port_recommended: null,
      location_network_type: null,
      is_vpc: false,
      last_job_id: null,
      buildarch: null,
    };
    const { service, cache, enqueueCollectionJob } = buildHarness({ record: healthy });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(enqueueCollectionJob).toHaveBeenCalledTimes(1);
    const setNxArgs = (cache.setNxOwned as Mock<(...args: any[]) => any>).mock.calls[0];
    expect(setNxArgs[2]).toBe(COOLDOWN_REFRESH_S);
  });

  it('swallows exceptions', async () => {
    const { service, enqueueCollectionJob } = buildHarness({
      existsRaises: new Error('redis dead'),
    });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(enqueueCollectionJob).not.toHaveBeenCalled();
  });

  it('saga lock key matches acquireLock wire key', () => {
    expect(sagaLockKey(DEV)).toBe(`lock:device:${DEV}`);
  });

  it('cooldown cleared when enqueue returns false', async () => {
    const { service, cache } = buildHarness({
      record: null,
      enqueueReturn: false,
    });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(cache.delete).toHaveBeenCalledTimes(1);
  });

  it('cooldown cleared when enqueue raises', async () => {
    const { service, cache } = buildHarness({
      record: null,
      enqueueRaises: new Error('queue dead'),
    });
    await service.maybeEnqueueCollectionOnRegister(DEV);
    expect(cache.delete).toHaveBeenCalledTimes(1);
  });
});
