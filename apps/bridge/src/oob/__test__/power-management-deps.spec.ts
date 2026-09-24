import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../../common/redis/redis.service';
import { performIpmiWithRetry } from '../../lifecycle-deploy/ipmi-operations';
import { ContextLogger } from '../../logger/logger.service';

import { buildPowerManagementDeps } from '../oob.module';

vi.mock('../../lifecycle-deploy/ipmi-operations', () => ({
  performIpmiWithRetry: vi.fn(async () => ({ result: 'success', response: '' })),
}));

const mockedRetry = vi.mocked(performIpmiWithRetry);

const stubRedis = { connection: {} } as unknown as RedisService;

function makeDeps() {
  return buildPowerManagementDeps(stubRedis, new ContextLogger());
}

describe('buildPowerManagementDeps retry adapter', () => {
  beforeEach(() => {
    mockedRetry.mockClear();
  });

  it('forwards a one-time override to performIpmiWithRetry', async () => {
    const deps = makeDeps();
    const device = deps.deviceFactory.create({ ip: '10.0.0.1', username: 'admin', password: 's3cret', jobId: 'job-1' });

    await deps.retry.performIpmiWithRetry(device, 'pxe', 'job-1', { maxRetries: 1, persistent: false });

    expect(mockedRetry.mock.calls[0]?.[4]).toEqual({ uefi: undefined, persistent: false });
  });

  it('forwards a persistent override unchanged', async () => {
    const deps = makeDeps();
    const device = deps.deviceFactory.create({ ip: '10.0.0.1', username: 'admin', password: 's3cret', jobId: 'job-1' });

    await deps.retry.performIpmiWithRetry(device, 'pxe', 'job-1', { maxRetries: 3, uefi: true, persistent: true });

    expect(mockedRetry.mock.calls[0]?.[3]).toBe(3);
    expect(mockedRetry.mock.calls[0]?.[4]).toEqual({ uefi: true, persistent: true });
  });
});
