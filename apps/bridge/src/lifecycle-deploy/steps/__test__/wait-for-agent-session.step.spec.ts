import { describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { WaitForAgentSessionStep } from '../wait-for-agent-session.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'wait_for_agent_session',
    deviceId: 'dev-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

interface HandleLike {
  agentVersion: string;
  connectedAt: number;
}

interface RegistryOptions {
  live?: HandleLike | null;
  registration?: HandleLike | null;
  evicted?: number;
}

function makeStep(opts: RegistryOptions = {}, clockValues: number[] = [0, 0]) {
  const registry = {
    get: vi.fn().mockReturnValue(opts.live ?? null),
    waitForRegistration: vi.fn().mockResolvedValue(opts.registration ?? null),
    cancelSessionsBefore: vi.fn().mockResolvedValue(opts.evicted ?? 0),
  };
  const logger = { info: vi.fn().mockResolvedValue(undefined) };
  let i = 0;
  const clock = { now: vi.fn(() => clockValues[Math.min(i++, clockValues.length - 1)]) };
  const step = new WaitForAgentSessionStep(registry, logger, clock);
  return { step, registry, logger, clock };
}

describe('WaitForAgentSessionStep', () => {
  it('short-circuits without waiting when the agent is already connected', async () => {
    const { step, registry } = makeStep({ live: { agentVersion: '1.0.0', connectedAt: 100 } });

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ reconnected: false, waited_s: 0.0 });
    expect(registry.waitForRegistration).not.toHaveBeenCalled();
  });

  it('short-circuits when no reset is recorded', async () => {
    const { step, registry } = makeStep({ live: { agentVersion: '1.0.0', connectedAt: 100 } });

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { action: 'enabled', success: true } } }));

    expect(result).toEqual({ reconnected: false, waited_s: 0.0 });
    expect(registry.waitForRegistration).not.toHaveBeenCalled();
    expect(registry.cancelSessionsBefore).not.toHaveBeenCalled();
  });

  it('short-circuits on a handle newer than the tee_config host reset', async () => {
    const { step, registry } = makeStep({ live: { agentVersion: '1.0.0', connectedAt: 300 } });

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(result).toEqual({ reconnected: false, waited_s: 0.0 });
    expect(registry.waitForRegistration).not.toHaveBeenCalled();
  });

  it('does not short-circuit on a handle older than the tee_config host reset', async () => {
    const { step, registry } = makeStep({
      live: { agentVersion: '1.0.0', connectedAt: 100 },
      registration: { agentVersion: '1.0.0', connectedAt: 300 },
    });

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(result).toMatchObject({ reconnected: true });
    expect(registry.waitForRegistration).toHaveBeenCalledWith('dev-1', 180, { minConnectedAt: 200 });
  });

  it('returns the handle registered after the reset', async () => {
    const { step } = makeStep(
      {
        live: { agentVersion: '1.0.0', connectedAt: 100 },
        registration: { agentVersion: '2.0.0', connectedAt: 300 },
      },
      [10, 22.5],
    );

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(result).toEqual({ reconnected: true, waited_s: 12.5, agent_version: '2.0.0' });
  });

  it('evicts the pre-reset sessions once a post-reset session is found', async () => {
    const { step, registry, logger } = makeStep({
      live: { agentVersion: '1.0.0', connectedAt: 100 },
      registration: { agentVersion: '1.0.0', connectedAt: 300 },
      evicted: 1,
    });

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(result).toMatchObject({ reconnected: true });
    expect(registry.cancelSessionsBefore).toHaveBeenCalledWith('dev-1', 200);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Cancelled 1 agent gRPC session(s)'), {
      jobId: 'job-1',
    });
  });

  it('evicts the pre-reset sessions when the live session already postdates the reset', async () => {
    const { step, registry, logger } = makeStep({ live: { agentVersion: '1.0.0', connectedAt: 300 }, evicted: 2 });

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(result).toEqual({ reconnected: false, waited_s: 0.0 });
    expect(registry.waitForRegistration).not.toHaveBeenCalled();
    expect(registry.cancelSessionsBefore).toHaveBeenCalledWith('dev-1', 200);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Cancelled 2 agent gRPC session(s)'), {
      jobId: 'job-1',
    });
  });

  it('logs nothing about eviction when no session predates the reset', async () => {
    const { step, registry, logger } = makeStep({ live: { agentVersion: '1.0.0', connectedAt: 300 } });

    await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(registry.cancelSessionsBefore).toHaveBeenCalledWith('dev-1', 200);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('throws when waitForRegistration returns null (timeout / no registration)', async () => {
    const { step } = makeStep({ live: null, registration: null });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('did not register a gRPC session');
  });

  it('waits with the reset as the floor when no session is live and evicts the older ones once one registers', async () => {
    const { step, registry } = makeStep({
      live: null,
      registration: { agentVersion: '2.0.0', connectedAt: 300 },
      evicted: 1,
    });

    const result = await step.execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }));

    expect(result).toMatchObject({ reconnected: true, agent_version: '2.0.0' });
    expect(registry.waitForRegistration).toHaveBeenCalledWith('dev-1', 180, { minConnectedAt: 200 });
    expect(registry.cancelSessionsBefore).toHaveBeenCalledWith('dev-1', 200);
  });

  it('throws without evicting when no session registers after the reset', async () => {
    const { step, registry } = makeStep({ live: null, registration: null });

    const error = await step
      .execute(makeCtx({ stepResults: { tee_config: { host_reset_at: 200 } } }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(registry.waitForRegistration).toHaveBeenCalledWith('dev-1', 180, { minConnectedAt: 200 });
    expect(registry.cancelSessionsBefore).not.toHaveBeenCalled();
  });

  it('returns a reconnected result with the agent version and elapsed time on success', async () => {
    const { step, registry } = makeStep(
      { live: null, registration: { agentVersion: '1.2.3', connectedAt: 50 } },
      [10, 22.5],
    );

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ reconnected: true, waited_s: 12.5, agent_version: '1.2.3' });
    expect(registry.waitForRegistration).toHaveBeenCalledWith('dev-1', 180, { minConnectedAt: null });
    expect(registry.cancelSessionsBefore).not.toHaveBeenCalled();
  });
});
