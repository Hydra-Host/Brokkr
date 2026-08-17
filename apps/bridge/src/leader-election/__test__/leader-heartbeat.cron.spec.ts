import { describe, expect, it, vi } from 'vitest';

import type { LeaderElectionService } from '../leader-election.service';
import { LeaderHeartbeatCron } from '../leader-heartbeat.cron';

interface FakeServiceOptions {
  heartbeat: (signal?: AbortSignal) => Promise<void>;
}

function fakeService(opts: FakeServiceOptions): LeaderElectionService {
  return {
    heartbeat: opts.heartbeat,
  } as unknown as LeaderElectionService;
}

describe('LeaderHeartbeatCron', () => {
  it('tick invokes heartbeat on the injected service', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const cron = new LeaderHeartbeatCron(fakeService({ heartbeat }));

    await cron.tick();

    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('tick is a no-op when no service is provided', async () => {
    const cron = new LeaderHeartbeatCron(null);
    await expect(cron.tick()).resolves.toBeUndefined();
  });

  it('tick forwards the cron-base signal verbatim to heartbeat (single deadline owner)', async () => {
    let captured: AbortSignal | undefined;
    const heartbeat = (signal?: AbortSignal): Promise<void> => {
      captured = signal;
      return Promise.resolve();
    };
    const cron = new LeaderHeartbeatCron(fakeService({ heartbeat }));
    const outer = new AbortController();

    await cron.tick(outer.signal);

    expect(captured).toBe(outer.signal);
  });

  it('tick does not arm its own deadline: a hung heartbeat stays pending until cron-base aborts', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const heartbeat = (): Promise<void> => new Promise<void>(() => undefined);
      const cron = new LeaderHeartbeatCron(fakeService({ heartbeat }));

      void cron.tick(new AbortController().signal).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tick propagates errors thrown by heartbeat', async () => {
    const heartbeat = vi.fn().mockRejectedValue(new Error('renewal failed'));
    const cron = new LeaderHeartbeatCron(fakeService({ heartbeat }));

    await expect(cron.tick()).rejects.toThrow('renewal failed');
  });
});
