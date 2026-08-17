import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CronSpec } from '../cron-base.js';
import { register, resetForTests } from '../cron-registry.js';
import { CronSupervisor } from '../cron-supervisor.service.js';

const noop = async (): Promise<void> => undefined;

function spec(name: string, intervalMs: number = 20): CronSpec {
  return { name, intervalMs, run: noop };
}

beforeEach(() => resetForTests());
afterEach(() => resetForTests());

describe('CronSupervisor', () => {
  it('startAll creates one task per registered spec', async () => {
    register(spec('a'));
    register(spec('b'));
    const supervisor = new CronSupervisor();
    await supervisor.startAll();
    try {
      const names = supervisor
        .states()
        .map((s) => s.name)
        .sort();
      expect(names).toEqual(['a', 'b']);
    } finally {
      await supervisor.stopAll();
    }
  });

  it('stopAll on a never-started supervisor is a no-op', async () => {
    const supervisor = new CronSupervisor();
    await supervisor.stopAll();
    expect(supervisor.states()).toEqual([]);
  });

  it('stopAll collects per-task failures without raising', async () => {
    register(spec('good'));
    register(spec('bad'));
    const supervisor = new CronSupervisor();
    await supervisor.startAll();

    const badTask = supervisor.tasks.get('bad');
    if (badTask === undefined) throw new Error('bad task missing');
    const originalStop = badTask.stop.bind(badTask);
    badTask.stop = async (): Promise<void> => {
      throw new Error('stop failed');
    };

    try {
      await expect(supervisor.stopAll()).resolves.toBeUndefined();
    } finally {
      badTask.stop = originalStop;
      await originalStop();
    }
  });

  it('states reflects one entry per started task', async () => {
    register(spec('x', 20));
    const supervisor = new CronSupervisor();
    await supervisor.startAll();
    try {
      const states = supervisor.states();
      expect(states).toHaveLength(1);
      expect(states[0].name).toBe('x');
      expect(states[0].intervalSeconds).toBeCloseTo(0.02);
    } finally {
      await supervisor.stopAll();
    }
  });

  it('empty registry starts zero tasks', async () => {
    const supervisor = new CronSupervisor();
    await supervisor.startAll();
    try {
      expect(supervisor.states()).toEqual([]);
    } finally {
      await supervisor.stopAll();
    }
  });
});
