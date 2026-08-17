import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logWarning } from '../../logger/logger.service';
import { CronSupervisor } from '../cron-supervisor.service';
import { CronsModule } from '../crons.module';

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
}));

const mockedLogWarning = vi.mocked(logWarning);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CronsModule.onApplicationShutdown', () => {
  it('stops the supervisor', async () => {
    const supervisor = new CronSupervisor();
    const stopAll = vi.spyOn(supervisor, 'stopAll').mockResolvedValue(undefined);

    await new CronsModule(supervisor).onApplicationShutdown();

    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('resolves instead of throwing when the supervisor fails, so the shutdown sweep continues', async () => {
    const supervisor = new CronSupervisor();
    vi.spyOn(supervisor, 'stopAll').mockRejectedValue(new Error('cron stop exploded'));

    await expect(new CronsModule(supervisor).onApplicationShutdown()).resolves.toBeUndefined();
    expect(mockedLogWarning).toHaveBeenCalledWith(
      expect.stringContaining('Cron supervisor stop failed during shutdown'),
      expect.anything(),
    );
  });
});
