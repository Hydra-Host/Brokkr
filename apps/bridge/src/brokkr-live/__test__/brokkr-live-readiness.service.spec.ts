import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionRegistry } from '../../agent/connection-registry/connection-registry.service';
import { resetBullmqConfigForTests } from '../../bullmq/bullmq.config';
import { ShutdownRequested } from '../../common/async/shutdown-signal';
import {
  BrokkrLiveReadinessService,
  BrokkrLiveReadinessServiceFactory,
  type BrokkrLiveReadinessLogger,
  type BrokkrLiveReadinessTiming,
} from '../brokkr-live-readiness.service';

function mockRegistry(impl: Partial<ConnectionRegistry> = {}): ConnectionRegistry {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    ...impl,
  } as unknown as ConnectionRegistry;
}

interface LoggerCapture {
  logger: BrokkrLiveReadinessLogger;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function captureLogger(): LoggerCapture {
  const info = vi.fn(async () => {});
  const error = vi.fn(async () => {});
  return { logger: { info, error }, info, error };
}

function fakeTiming(overrides: Partial<BrokkrLiveReadinessTiming> = {}): BrokkrLiveReadinessTiming {
  let clock = 0;
  return {
    initialDelaySeconds: 0,
    maxWaitSeconds: 600,
    now: () => clock,
    sleep: async (seconds: number) => {
      clock += seconds;
    },
    ...overrides,
  };
}

const infoMessages = (info: ReturnType<typeof vi.fn>): string[] => info.mock.calls.map((c) => String(c[0]));

afterEach(() => {
  vi.unstubAllEnvs();
  resetBullmqConfigForTests();
});

describe('BrokkrLiveReadinessService.waitForBrokkrLive', () => {
  it('returns true when connectivity arrives on the Nth poll', async () => {
    let calls = 0;
    const registry = mockRegistry({
      isConnected: vi.fn(() => {
        calls += 1;
        return calls >= 3;
      }),
    });
    const { logger, info } = captureLogger();
    const service = new BrokkrLiveReadinessService('job-1', registry, logger, fakeTiming());

    const result = await service.waitForBrokkrLive('device-1', { initialDelay: 0 });

    expect(result).toBe(true);
    expect(registry.isConnected).toHaveBeenCalledTimes(3);
    expect(infoMessages(info).some((m) => m.includes('connected'))).toBe(true);
  });

  it('returns false after the configured cap when connectivity never arrives', async () => {
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger, error } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-2',
      registry,
      logger,
      fakeTiming({ maxWaitSeconds: 20, pollIntervalSeconds: 5 }),
    );

    const result = await service.waitForBrokkrLive('device-2', { initialDelay: 0 });

    expect(result).toBe(false);
    expect(registry.isConnected).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('did not connect');
  });

  it('fails early after repeated diagnostic failures', async () => {
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const diagnosticCheck = vi.fn(async () => ({ ok: false, reason: 'BMC power-on verification failed' }));
    const { logger, info, error } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-diagnostic',
      registry,
      logger,
      fakeTiming({
        maxWaitSeconds: 60,
        pollIntervalSeconds: 5,
        diagnosticIntervalSeconds: 10,
        diagnosticFailuresToFail: 2,
      }),
    );

    await expect(
      service.waitForBrokkrLive('device-diagnostic', {
        initialDelay: 0,
        diagnosticCheck,
      }),
    ).rejects.toThrow(
      'Brokkr Live readiness failed early for device device-diagnostic: BMC power-on verification failed',
    );

    expect(diagnosticCheck).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    expect(infoMessages(info).filter((m) => m.includes('readiness diagnostic failed'))).toHaveLength(2);
  });

  it('resets the failure counter on an intervening ok diagnostic', async () => {
    let polls = 0;
    const registry = mockRegistry({
      isConnected: vi.fn(() => {
        polls += 1;
        return polls >= 4;
      }),
    });
    const results = [{ ok: false, reason: 'first' }, { ok: true }, { ok: false, reason: 'second' }];
    let call = 0;
    const diagnosticCheck = vi.fn(async () => results[Math.min(call++, results.length - 1)]);
    const { logger, error } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-reset',
      registry,
      logger,
      fakeTiming({
        maxWaitSeconds: 120,
        pollIntervalSeconds: 5,
        diagnosticIntervalSeconds: 5,
        diagnosticFailuresToFail: 2,
      }),
    );

    const result = await service.waitForBrokkrLive('device-reset', { initialDelay: 0, diagnosticCheck });

    expect(result).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it('does not abort on repeated inconclusive diagnostics', async () => {
    let polls = 0;
    const registry = mockRegistry({
      isConnected: vi.fn(() => {
        polls += 1;
        return polls >= 6;
      }),
    });
    const diagnosticCheck = vi.fn(async () => ({ ok: false, inconclusive: true, reason: 'BMC briefly unreachable' }));
    const { logger, info, error } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-inconclusive',
      registry,
      logger,
      fakeTiming({
        maxWaitSeconds: 120,
        pollIntervalSeconds: 5,
        diagnosticIntervalSeconds: 5,
        diagnosticFailuresToFail: 2,
      }),
    );

    const result = await service.waitForBrokkrLive('device-inconclusive', { initialDelay: 0, diagnosticCheck });

    expect(result).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(diagnosticCheck.mock.calls.length).toBeGreaterThan(2);
    const breadcrumbs = infoMessages(info).filter((m) => m.includes('diagnostic inconclusive'));
    expect(breadcrumbs.length).toBeGreaterThanOrEqual(1);
    expect(breadcrumbs[0]).toContain('device-inconclusive');
  });

  it('emits a progress log at the log interval while waiting', async () => {
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger, info } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-3',
      registry,
      logger,
      fakeTiming({ maxWaitSeconds: 60, pollIntervalSeconds: 5, logIntervalSeconds: 30 }),
    );

    await service.waitForBrokkrLive('device-3', { initialDelay: 0 });

    const progressLogs = infoMessages(info).filter((m) => m.includes('Still waiting'));
    expect(progressLogs.length).toBeGreaterThanOrEqual(1);
    expect(progressLogs[0]).toContain('device-3');
  });

  it('logs once when the readiness wait is longer than expected', async () => {
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger, info } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-long',
      registry,
      logger,
      fakeTiming({
        maxWaitSeconds: 40,
        pollIntervalSeconds: 5,
        longerThanExpectedSeconds: 15,
      }),
    );

    await service.waitForBrokkrLive('device-long', { initialDelay: 0 });

    const longerThanExpectedLogs = infoMessages(info).filter((m) => m.includes('readiness longer than expected'));
    expect(longerThanExpectedLogs).toHaveLength(1);
    expect(longerThanExpectedLogs[0]).toContain('waiting_for=agent_registration');
    expect(longerThanExpectedLogs[0]).toContain('expected=15s');
    expect(longerThanExpectedLogs[0]).toContain('cap=40s');
  });

  it('runs without real wall-clock delays', async () => {
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger } = captureLogger();
    const service = new BrokkrLiveReadinessService('job-4', registry, logger, fakeTiming({ maxWaitSeconds: 600 }));

    const startedAt = Date.now();
    const result = await service.waitForBrokkrLive('device-4', { initialDelay: 90 });
    const wallMs = Date.now() - startedAt;

    expect(result).toBe(false);
    expect(wallMs).toBeLessThan(1000);
  });

  it('uses the configured initial delay and wait cap from the factory', async () => {
    vi.stubEnv('BROKKR_LIVE_INITIAL_DELAY_SECONDS', '7');
    vi.stubEnv('BROKKR_LIVE_WAIT_SECONDS', '20');
    resetBullmqConfigForTests();
    let clock = 0;
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger } = captureLogger();
    const sleep = vi.fn(async (seconds: number) => {
      clock += seconds;
    });
    const factory = new BrokkrLiveReadinessServiceFactory(registry, logger);
    const service = await factory.create('job-5', {
      now: () => clock,
      sleep,
      pollIntervalSeconds: 5,
    });

    await service.waitForBrokkrLive('device-5');

    expect(sleep.mock.calls[0]?.[0]).toBe(7);
    expect(registry.isConnected).toHaveBeenCalledTimes(4);
  });

  it('production defaults preserve the 1800s cap and 5s poll', async () => {
    let clock = 0;
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger } = captureLogger();
    const factory = new BrokkrLiveReadinessServiceFactory(registry, logger);
    const service = await factory.create('job-5b', {
      now: () => clock,
      sleep: async (seconds: number) => {
        clock += seconds;
      },
    });

    await service.waitForBrokkrLive('device-5b', { initialDelay: 0 });

    expect(registry.isConnected).toHaveBeenCalledTimes(360);
  });

  it('production defaults emit the longer-than-expected log at 600s with the 1800s cap', async () => {
    let clock = 0;
    const registry = mockRegistry({ isConnected: vi.fn().mockReturnValue(false) });
    const { logger, info } = captureLogger();
    const factory = new BrokkrLiveReadinessServiceFactory(registry, logger);
    const service = await factory.create('job-6', {
      now: () => clock,
      sleep: async (seconds: number) => {
        clock += seconds;
      },
    });

    await service.waitForBrokkrLive('device-6', { initialDelay: 0 });

    const longerThanExpectedLogs = infoMessages(info).filter((m) => m.includes('readiness longer than expected'));
    expect(longerThanExpectedLogs).toHaveLength(1);
    expect(longerThanExpectedLogs[0]).toContain('expected=600s');
    expect(longerThanExpectedLogs[0]).toContain('cap=1800s');
  });
});

describe('BrokkrLiveReadinessService.waitForBrokkrLive — shutdown', () => {
  it('throws before the first poll when shutdown was already requested', async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = mockRegistry();
    const { logger, info } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-shutdown-pre',
      registry,
      logger,
      fakeTiming(),
      () => controller.signal,
    );

    await expect(service.waitForBrokkrLive('device-shutdown-pre', { initialDelay: 90 })).rejects.toThrow(
      ShutdownRequested,
    );
    expect(registry.isConnected).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('abandons the 90s boot delay within a second when shutdown is requested mid-wait', async () => {
    const controller = new AbortController();
    const registry = mockRegistry();
    const { logger } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-shutdown-delay',
      registry,
      logger,
      { initialDelaySeconds: 90, maxWaitSeconds: 600 },
      () => controller.signal,
    );

    const startedAt = Date.now();
    const waiting = service.waitForBrokkrLive('device-shutdown-delay', { initialDelay: 90 });
    const abortTimer = setTimeout(() => controller.abort(), 20);

    await expect(waiting).rejects.toThrow(ShutdownRequested);
    clearTimeout(abortTimer);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(registry.isConnected).not.toHaveBeenCalled();
  });

  it('stops the poll loop on the iteration after shutdown is requested', async () => {
    const controller = new AbortController();
    let polls = 0;
    const registry = mockRegistry({
      isConnected: vi.fn(() => {
        polls += 1;
        if (polls === 2) controller.abort();
        return false;
      }),
    });
    const { logger } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-shutdown-loop',
      registry,
      logger,
      fakeTiming({ maxWaitSeconds: 600, pollIntervalSeconds: 5 }),
      () => controller.signal,
    );

    await expect(service.waitForBrokkrLive('device-shutdown-loop', { initialDelay: 0 })).rejects.toThrow(
      ShutdownRequested,
    );
    expect(polls).toBe(2);
  });

  it('passes the shutdown signal to every wait it performs', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    let clock = 0;
    const registry = mockRegistry();
    const { logger } = captureLogger();
    const service = new BrokkrLiveReadinessService(
      'job-shutdown-plumbing',
      registry,
      logger,
      {
        initialDelaySeconds: 0,
        now: () => clock,
        sleep: async (seconds: number, signal?: AbortSignal) => {
          seen.push(signal);
          clock += seconds;
        },
        maxWaitSeconds: 10,
        pollIntervalSeconds: 5,
      },
      () => controller.signal,
    );

    await service.waitForBrokkrLive('device-shutdown-plumbing', { initialDelay: 90 });

    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });
});
