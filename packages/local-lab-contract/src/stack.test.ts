import { describe, expect, it } from 'vitest';

import { contract } from './index';
import { RESTART_STALE_AFTER_LABEL, RESTART_STALE_AFTER_MS, RestartStatusSchema } from './schemas/stack';

describe('RESTART_STALE_AFTER_MS', () => {
  it('is the 30-minute bound both processes apply', () => {
    expect(RESTART_STALE_AFTER_MS).toBe(30 * 60 * 1000);
    expect(RESTART_STALE_AFTER_LABEL).toBe('30 minutes');
  });

  it('derives the status description, so the prose cannot drift from the number', () => {
    expect(RestartStatusSchema.description).toContain(`past ${RESTART_STALE_AFTER_LABEL}`);
  });

  it('derives the endpoint description too', () => {
    expect(contract.getRestartState.description).toContain(`past ${RESTART_STALE_AFTER_LABEL}`);
  });

  it('hard-codes no other minute count in either description', () => {
    for (const prose of [RestartStatusSchema.description, contract.getRestartState.description]) {
      expect([...(prose ?? '').matchAll(/(\d+) minutes/g)].map((m) => m[1])).toEqual(['30']);
    }
  });
});

describe('RestartStatusSchema', () => {
  it('is the only discriminant, with no boolean twin on the state shape', () => {
    expect(RestartStatusSchema.options).toEqual(['idle', 'pending', 'stale', 'failed']);
    const shape = Object.keys(contract.getRestartState.responses[200].shape);
    expect(shape).toContain('status');
    expect(shape).not.toContain('pending');
    expect(shape).not.toContain('stale');
    expect(shape).not.toContain('failed');
  });
});
