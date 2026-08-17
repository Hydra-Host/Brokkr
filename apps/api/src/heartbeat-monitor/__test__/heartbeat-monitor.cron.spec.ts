import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerService } from '../../logger/logger.service';
import { HeartbeatMonitorCron } from '../heartbeat-monitor.cron';
import type { HeartbeatMonitorService } from '../heartbeat-monitor.service';

const JOB = {} as Job;

const ZONES = [
  { zoneId: 'zone-a', zoneName: 'Zone A', isOnline: false, flapSuppressed: true },
  { zoneId: 'zone-b', zoneName: 'Zone B', isOnline: false },
  { zoneId: 'zone-c', zoneName: 'Zone C', isOnline: true },
];

function buildCron(opts?: { enabled?: string }) {
  const checkBridgePresence = vi.fn().mockResolvedValue(ZONES);
  const publishZoneOfflineEvent = vi.fn().mockResolvedValue(undefined);
  const heartbeatMonitorService = {
    checkBridgePresence,
    publishZoneOfflineEvent,
  } as unknown as HeartbeatMonitorService;

  const configService = { get: vi.fn().mockReturnValue(opts?.enabled ?? 'true') } as unknown as ConfigService;
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const cron = new HeartbeatMonitorCron(heartbeatMonitorService, configService, logger);

  const pause = vi.fn(async () => {});
  (cron as unknown as { _worker: { pause: typeof pause } })._worker = { pause };

  return { cron, checkBridgePresence, publishZoneOfflineEvent, logger, pause };
}

describe('HeartbeatMonitorCron.process', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the sweep once and publishes each offline zone exactly once', async () => {
    const { cron, checkBridgePresence, publishZoneOfflineEvent, logger } = buildCron();

    await cron.process(JOB);

    expect(checkBridgePresence).toHaveBeenCalledOnce();
    expect(publishZoneOfflineEvent).toHaveBeenCalledTimes(2);
    expect(publishZoneOfflineEvent).toHaveBeenCalledWith('zone-a', 'Zone A', true);
    expect(publishZoneOfflineEvent).toHaveBeenCalledWith('zone-b', 'Zone B', false);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Bridge presence check completed'));
  });

  it('throws without sweeping when disabled so the tick fails instead of being silently acked', async () => {
    const { cron, checkBridgePresence } = buildCron({ enabled: 'false' });

    await expect(cron.process(JOB)).rejects.toThrow();
    expect(checkBridgePresence).not.toHaveBeenCalled();
  });

  it('rethrows a sweep failure so the tick is marked failed', async () => {
    const { cron, checkBridgePresence } = buildCron();
    checkBridgePresence.mockRejectedValueOnce(new Error('redis down'));

    await expect(cron.process(JOB)).rejects.toThrow('redis down');
  });

  it('logs but does not fail the sweep when an offline-event publish throws', async () => {
    const { cron, publishZoneOfflineEvent, logger } = buildCron();
    publishZoneOfflineEvent.mockRejectedValueOnce(new Error('publish failed'));

    await expect(cron.process(JOB)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to publish offline event'));
  });

  it('pauses the worker on bootstrap when disabled', async () => {
    const { cron, pause } = buildCron({ enabled: 'false' });
    await cron.onApplicationBootstrap();
    expect(pause).toHaveBeenCalledOnce();
  });

  it('does not pause the worker on bootstrap when enabled', async () => {
    const { cron, pause } = buildCron();
    await cron.onApplicationBootstrap();
    expect(pause).not.toHaveBeenCalled();
  });
});
