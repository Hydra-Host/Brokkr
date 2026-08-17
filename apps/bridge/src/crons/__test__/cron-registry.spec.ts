import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CronSpec } from '../cron-base.js';
import { allSpecs, register, resetForTests } from '../cron-registry.js';

const noop = async (): Promise<void> => undefined;

function makeSpec(name: string, intervalMs: number = 1000): CronSpec {
  return { name, intervalMs, run: noop };
}

beforeEach(() => resetForTests());
afterEach(() => resetForTests());

describe('cron registry', () => {
  it('register and allSpecs round-trip in registration order', () => {
    const a = makeSpec('a', 1000);
    const b = makeSpec('b', 2000);
    register(a);
    register(b);
    expect(allSpecs().map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('register is idempotent for an equivalent re-registration', () => {
    register(makeSpec('dup', 1000));
    expect(() => register(makeSpec('dup', 1000))).not.toThrow();
    expect(allSpecs().filter((s) => s.name === 'dup')).toHaveLength(1);
  });

  it('register rejects a different spec under an existing name', () => {
    register(makeSpec('dup', 1000));
    expect(() => register(makeSpec('dup', 2000))).toThrow(/different spec/);
  });

  it('resetForTests empties the registry', () => {
    register(makeSpec('ephemeral'));
    expect(allSpecs()).toHaveLength(1);
    resetForTests();
    expect(allSpecs()).toEqual([]);
  });

  it('allSpecs returns a fresh array', () => {
    register(makeSpec('x'));
    const first = allSpecs();
    first.push(makeSpec('mutation-attempt'));
    expect(allSpecs()).toHaveLength(1);
  });
});
