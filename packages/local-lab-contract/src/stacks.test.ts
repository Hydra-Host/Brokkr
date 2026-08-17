import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';

import { contract } from './index';
import { RegisteredStackSchema } from './schemas/stacks';

describe('listStacks', () => {
  it('is a GET on /api/stacks', () => {
    const route = contract.listStacks;
    if (!isAppRoute(route)) throw new Error('listStacks not a route');
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/api/stacks');
  });

  it('200 parses a full stack entry and rejects a missing process rollup', () => {
    const route = contract.listStacks;
    if (!isAppRoute(route)) throw new Error('listStacks not a route');
    const stack = {
      slot: 0,
      checkout: '/work/boss',
      state: 'up',
      live: true,
      hubUrl: 'http://localhost:3000',
      webUrl: 'http://localhost:5173',
      labUrl: 'http://localhost:3002',
      labWebUrl: 'http://localhost:5175',
      healthLine: null,
      processes: { running: 12, total: 14 },
    };
    expect(route.responses[200].parse({ stacks: [stack], selfSlot: 1 })).toEqual({ stacks: [stack], selfSlot: 1 });
    expect(() => route.responses[200].parse({ stacks: [{ ...stack, processes: undefined }], selfSlot: 1 })).toThrow();
    expect(() => route.responses[200].parse({ stacks: [stack] })).toThrow();
  });

  it('accepts null urls for an entry not yet stamped with ports', () => {
    const parsed = RegisteredStackSchema.parse({
      slot: 1,
      checkout: '/a',
      state: 'up',
      live: false,
      hubUrl: null,
      webUrl: null,
      labUrl: null,
      labWebUrl: null,
      processes: { running: 0, total: 0 },
      healthLine: null,
    });
    expect(parsed.hubUrl).toBeNull();
    expect(parsed.labWebUrl).toBeNull();
  });

  it('rejects a non-integer slot', () => {
    expect(() =>
      RegisteredStackSchema.parse({
        slot: 1.5,
        checkout: '/a',
        state: 'up',
        live: false,
        hubUrl: null,
        webUrl: null,
        labUrl: null,
        labWebUrl: null,
        processes: { running: 0, total: 0 },
      }),
    ).toThrow();
  });
});
