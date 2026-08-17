import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_HEALTH_CHECK_JOB, DEVICE_HEALTH_CHECK_SCHEDULE } from '../device-health-check.types';
import { HeartbeatMonitorModule } from '../heartbeat-monitor.module';
import { HEARTBEAT_MONITOR_JOB, HEARTBEAT_MONITOR_SCHEDULE } from '../heartbeat-monitor.types';

function buildModule(enabledFor: Record<string, string | undefined> = {}) {
  const deviceUpsert = vi.fn().mockResolvedValue(undefined);
  const heartbeatUpsert = vi.fn().mockResolvedValue(undefined);
  const removeJobScheduler = vi.fn().mockResolvedValue(undefined);
  const deviceHealthQueue = { upsertJobScheduler: deviceUpsert, removeJobScheduler } as unknown as Queue;
  const heartbeatQueue = { upsertJobScheduler: heartbeatUpsert, removeJobScheduler } as unknown as Queue;
  const configService = { get: vi.fn((key: string) => enabledFor[key]) } as unknown as ConfigService;
  const module = new HeartbeatMonitorModule(deviceHealthQueue, heartbeatQueue, configService);
  return { module, deviceUpsert, heartbeatUpsert, removeJobScheduler };
}

describe('HeartbeatMonitorModule.onModuleInit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers both repeatable schedulers under their job names with the configured patterns', async () => {
    const { module, deviceUpsert, heartbeatUpsert, removeJobScheduler } = buildModule();

    await module.onModuleInit();

    expect(removeJobScheduler).not.toHaveBeenCalled();
    expect(deviceUpsert).toHaveBeenCalledWith(
      DEVICE_HEALTH_CHECK_JOB,
      { pattern: DEVICE_HEALTH_CHECK_SCHEDULE },
      expect.objectContaining({ name: DEVICE_HEALTH_CHECK_JOB }),
    );
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      HEARTBEAT_MONITOR_JOB,
      { pattern: HEARTBEAT_MONITOR_SCHEDULE },
      expect.objectContaining({ name: HEARTBEAT_MONITOR_JOB }),
    );
  });

  it('configures retries so a tick failed during the startup race re-queues for an enabled instance', async () => {
    const { module, heartbeatUpsert } = buildModule();

    await module.onModuleInit();

    const [, , template] = heartbeatUpsert.mock.calls[0];
    expect(template.opts.attempts).toBeGreaterThan(1);
    expect(template.opts.backoff).toBeDefined();
  });

  it('gates each scheduler independently on its own enable flag', async () => {
    const { module, deviceUpsert, heartbeatUpsert } = buildModule({ HEARTBEAT_MONITOR_ENABLED: 'false' });

    await module.onModuleInit();

    expect(deviceUpsert).toHaveBeenCalledOnce();
    expect(heartbeatUpsert).not.toHaveBeenCalled();
  });

  it('skips both registrations when both are disabled', async () => {
    const { module, deviceUpsert, heartbeatUpsert } = buildModule({
      DEVICE_HEALTH_CHECK_ENABLED: 'false',
      HEARTBEAT_MONITOR_ENABLED: 'false',
    });

    await module.onModuleInit();

    expect(deviceUpsert).not.toHaveBeenCalled();
    expect(heartbeatUpsert).not.toHaveBeenCalled();
  });
});
