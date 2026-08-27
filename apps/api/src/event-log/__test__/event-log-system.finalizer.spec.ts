import { NotFoundException } from '@nestjs/common';
import { RequestSource } from '@repo/database';
import type { PermissionIntent } from 'src/common/context/context.service';
import { describe, expect, it, vi } from 'vitest';
import { EventLogSystemFinalizer } from '../event-log-system.finalizer';

const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

function intent(overrides: Partial<PermissionIntent> = {}): PermissionIntent {
  return { id: 'i1', resource: 'ipam', action: 'create', denied: false, finalized: false, ...overrides };
}

function buildHarness() {
  const recordBestEffort = vi.fn().mockResolvedValue(undefined);
  const finalizer = new EventLogSystemFinalizer({ recordBestEffort } as never, logger as never);
  return { finalizer, recordBestEffort };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  intents: [intent()],
  organizationId: 'org-sys',
  requestId: 'req-1',
  error: undefined,
  ...overrides,
});

describe('EventLogSystemFinalizer', () => {
  it('writes a SYSTEM row with no actor for a successful scope', async () => {
    const { finalizer, recordBestEffort } = buildHarness();

    await finalizer.finalize(input());

    expect(recordBestEffort).toHaveBeenCalledTimes(1);
    expect(recordBestEffort).toHaveBeenCalledWith({
      organizationId: 'org-sys',
      tier: 'ACTIVITY',
      durability: 'BEST_EFFORT',
      resource: 'ipam',
      action: 'create',
      actionKey: 'ipam.create',
      actorType: RequestSource.SYSTEM,
      actorId: null,
      actorLabel: null,
      apiKeyId: null,
      apiKeyLabel: null,
      targetId: null,
      targetLabel: null,
      outcome: 'SUCCEEDED',
      errorCode: null,
      requestId: 'req-1',
      method: null,
      path: null,
      ipAddress: null,
      userAgent: null,
      metadata: null,
    });
  });

  it('maps a scope error to FAILED with the resolved error code', async () => {
    const { finalizer, recordBestEffort } = buildHarness();

    await finalizer.finalize(input({ error: new NotFoundException('gone') }));

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED', errorCode: '404:NotFoundException' }),
    );
  });

  it('maps a denied intent to DENIED even when the scope itself succeeded', async () => {
    const { finalizer, recordBestEffort } = buildHarness();

    await finalizer.finalize(input({ intents: [intent({ denied: true })] }));

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DENIED' }));
  });

  it('writes one row per intent', async () => {
    const { finalizer, recordBestEffort } = buildHarness();

    await finalizer.finalize(input({ intents: [intent(), intent({ id: 'i2', action: 'update' })] }));

    expect(recordBestEffort).toHaveBeenCalledTimes(2);
    expect(recordBestEffort.mock.calls.map(([write]) => write.actionKey)).toEqual(['ipam.create', 'ipam.update']);
  });

  it('carries a null requestId rather than inventing one outside a request', async () => {
    const { finalizer, recordBestEffort } = buildHarness();

    await finalizer.finalize(input({ requestId: null }));

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ requestId: null }));
  });

  it('logs and swallows a write failure so the system operation still succeeds', async () => {
    const { finalizer, recordBestEffort } = buildHarness();
    recordBestEffort.mockRejectedValue(new Error('db down'));

    await expect(finalizer.finalize(input())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('still writes the intents behind one that failed', async () => {
    const { finalizer, recordBestEffort } = buildHarness();
    recordBestEffort.mockRejectedValueOnce(new Error('first row lost')).mockResolvedValue(undefined);

    await expect(
      finalizer.finalize(input({ intents: [intent(), intent({ id: 'i2', action: 'update' })] })),
    ).resolves.toBeUndefined();

    expect(recordBestEffort).toHaveBeenCalledTimes(2);
    expect(recordBestEffort.mock.calls.map(([write]) => write.actionKey)).toEqual(['ipam.create', 'ipam.update']);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ipam.create'));
  });

  it('writes nothing when the scope drained no intents', async () => {
    const { finalizer, recordBestEffort } = buildHarness();

    await finalizer.finalize(input({ intents: [] }));

    expect(recordBestEffort).not.toHaveBeenCalled();
  });
});
