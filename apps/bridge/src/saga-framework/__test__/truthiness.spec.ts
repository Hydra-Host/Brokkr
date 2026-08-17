import { describe, expect, it } from 'vitest';

import { pythonFalsy, pythonTruthy } from '../truthiness';

describe('pythonTruthy (Python-bool parity for irreducible boundaries)', () => {
  it('treats the Python-falsy set as falsy', () => {
    const falsy: unknown[] = [null, undefined, false, 0, 0n, '', NaN, [], {}, new Map(), new Set(), new Uint8Array(0)];
    for (const value of falsy) {
      expect(pythonTruthy(value)).toBe(false);
    }
  });

  it('treats non-empty / non-zero values as truthy', () => {
    const truthy: unknown[] = [
      true,
      1,
      -1,
      0.5,
      1n,
      'a',
      '0',
      [0],
      [null],
      [1],
      { a: 1 },
      new Map([['a', 1]]),
      new Set([0]),
      new Uint8Array([0]),
      () => undefined,
      Symbol('s'),
    ];
    for (const value of truthy) {
      expect(pythonTruthy(value)).toBe(true);
    }
  });

  it.each([
    ['[]', [], false],
    ['{}', {}, false],
    ["''", '', false],
    ['0', 0, false],
    ['NaN', NaN, false],
    ['[1]', [1], true],
    ['{a:1}', { a: 1 }, true],
  ])('matches Python bool() for %s', (_label, value, expected) => {
    expect(pythonTruthy(value)).toBe(expected);
  });
});

describe('pythonFalsy', () => {
  it('is the exact inverse of pythonTruthy', () => {
    const cases: unknown[] = [null, undefined, false, 0, 0n, '', NaN, [], {}, true, 1, 'a', [1], { a: 1 }];
    for (const value of cases) {
      expect(pythonFalsy(value)).toBe(!pythonTruthy(value));
    }
  });
});
