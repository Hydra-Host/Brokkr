import { describe, expect, it, vi } from 'vitest';

import { FleetResetService } from '../fleet-reset.service';

function makeService(inFlight: number) {
  const queueReader = { inFlightCount: vi.fn(() => Promise.resolve(inFlight)) };
  const svc = new FleetResetService({} as never, queueReader as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, queueReader };
}

describe('FleetResetService.countActiveSagaJobs — active-saga guard', () => {
  it('delegates to the queue reader and returns its number unchanged', async () => {
    const { svc, queueReader } = makeService(5);
    await expect(svc.countActiveSagaJobs()).resolves.toBe(5);
    expect(queueReader.inFlightCount).toHaveBeenCalledTimes(1);
  });

  it('passes a zero straight through (no block) rather than substituting a floor of its own', async () => {
    const { svc } = makeService(0);
    await expect(svc.countActiveSagaJobs()).resolves.toBe(0);
  });
});
