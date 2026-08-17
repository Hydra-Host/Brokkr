import { describe, expect, it } from 'vitest';

import { coerceEnvelopeId, hasEnvelopeId, jsonFlag } from '../dispatch-payload';

describe('coerceEnvelopeId', () => {
  it('passes through scalar identifiers', () => {
    expect(coerceEnvelopeId('dev-1')).toBe('dev-1');
    expect(coerceEnvelopeId('')).toBe('');
    expect(coerceEnvelopeId(99)).toBe(99);
    expect(coerceEnvelopeId(0)).toBe(0);
  });

  it('collapses absent / non-scalar inputs to undefined', () => {
    for (const value of [undefined, null, false, true, [], {}, [1], { a: 1 }]) {
      expect(coerceEnvelopeId(value)).toBeUndefined();
    }
  });
});

describe('hasEnvelopeId', () => {
  it('is true only for a present, non-empty, non-zero scalar', () => {
    expect(hasEnvelopeId('dev-1')).toBe(true);
    expect(hasEnvelopeId(99)).toBe(true);
  });

  it('is false for undefined, empty string, and zero', () => {
    expect(hasEnvelopeId(undefined)).toBe(false);
    expect(hasEnvelopeId('')).toBe(false);
    expect(hasEnvelopeId(0)).toBe(false);
  });
});

describe('jsonFlag — boolean flag parsed from untyped input JSON', () => {
  it.each([
    ['undefined', undefined, false],
    ['null', null, false],
    ['false', false, false],
    ['true', true, true],
    ['0', 0, false],
    ['1', 1, true],
    ['NaN', NaN, false],
    ["''", '', false],
    ["'x'", 'x', true],
    ['[]', [], false],
    ['[1]', [1], true],
    ['{}', {}, false],
    ['{a:1}', { a: 1 }, true],
  ])('parses %s to %s', (_label, value, expected) => {
    expect(jsonFlag(value)).toBe(expected);
  });
});
