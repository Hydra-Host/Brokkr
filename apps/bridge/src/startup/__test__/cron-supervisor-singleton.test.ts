import { afterEach, describe, expect, it, vi } from 'vitest';

import { CronSupervisor } from '../../crons/cron-supervisor.service.js';
import {
  configureCronSupervisor,
  getCronSupervisor,
  resetCronSupervisorForTests,
} from '../cron-supervisor-singleton.js';
import type { CronSupervisorLike } from '../startup-services.js';

function makeSupervisor(): CronSupervisorLike {
  return {
    startAll: async () => undefined,
    stopAll: async () => undefined,
    states: () => [],
  };
}

describe('getCronSupervisor', () => {
  afterEach(() => {
    resetCronSupervisorForTests();
  });

  it('returns the same instance on every call', () => {
    configureCronSupervisor(makeSupervisor);
    expect(getCronSupervisor()).toBe(getCronSupervisor());
  });

  it('constructs lazily on first call, not at configure time', () => {
    const make = vi.fn(makeSupervisor);
    configureCronSupervisor(make);
    expect(make).not.toHaveBeenCalled();
    getCronSupervisor();
    getCronSupervisor();
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('defaults to a real CronSupervisor when no factory is configured', () => {
    const supervisor = getCronSupervisor();
    expect(supervisor).toBeInstanceOf(CronSupervisor);
  });
});
