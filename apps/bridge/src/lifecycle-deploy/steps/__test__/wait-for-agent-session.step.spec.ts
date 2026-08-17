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

interface RegistryOptions {
  isConnected?: boolean;
  registration?: { agentVersion: string } | null;
}

function makeStep(opts: RegistryOptions = {}, clockValues: number[] = [0, 0]) {
  const registry = {
    isConnected: vi.fn().mockReturnValue(opts.isConnected ?? false),
    waitForRegistration: vi.fn().mockResolvedValue(opts.registration ?? null),
  };
  const logger = { info: vi.fn().mockResolvedValue(undefined) };
  let i = 0;
  const clock = { now: vi.fn(() => clockValues[Math.min(i++, clockValues.length - 1)]) };
  const step = new WaitForAgentSessionStep(registry, logger, clock);
  return { step, registry, logger, clock };
}

describe('WaitForAgentSessionStep', () => {
  it('short-circuits without waiting when the agent is already connected', async () => {
    const { step, registry } = makeStep({ isConnected: true });

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ reconnected: false, waited_s: 0.0 });
    expect(registry.waitForRegistration).not.toHaveBeenCalled();
  });

  it('throws when waitForRegistration returns null (timeout / no registration)', async () => {
    const { step } = makeStep({ isConnected: false, registration: null });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('did not register a gRPC session');
  });

  it('returns a reconnected result with the agent version and elapsed time on success', async () => {
    const { step } = makeStep({ isConnected: false, registration: { agentVersion: '1.2.3' } }, [10, 22.5]);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({ reconnected: true, waited_s: 12.5, agent_version: '1.2.3' });
  });
});
