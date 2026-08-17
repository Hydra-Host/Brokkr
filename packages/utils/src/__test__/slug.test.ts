import { describe, expect, it } from 'vitest';
import { slugify } from '../slug';

describe('slugify', () => {
  it('lowercases and dashes a normal name', () => {
    expect(slugify('Super Micro')).toBe('super-micro');
  });

  it('collapses consecutive special characters into a single dash', () => {
    expect(slugify('AMD, Inc.')).toBe('amd-inc');
  });

  it('trims leading and trailing special characters', () => {
    expect(slugify('!NVIDIA!')).toBe('nvidia');
  });

  it('returns an empty string when the name is all special characters', () => {
    expect(slugify('---')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});
