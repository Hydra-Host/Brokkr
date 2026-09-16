import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envInt } from '../env-utils.js';

const schema = z.object({ N: envInt(7) });

describe('envInt', () => {
  it('returns the default when the variable is unset', () => {
    expect(schema.parse({})).toEqual({ N: 7 });
  });

  it.each([
    ['30', 30],
    ['007', 7],
    [' 5 ', 5],
    ['+5', 5],
    ['-5', -5],
    ['1_000', 1000],
  ])('parses %j like python int()', (value, expected) => {
    expect(schema.parse({ N: value })).toEqual({ N: expected });
  });

  it.each(['', '1.5', 'abc', '1__000', '_5', '5_', '1e3'])('rejects %j', (value) => {
    expect(() => schema.parse({ N: value })).toThrow(/invalid integer/);
  });
});
