import { describe, expect, it } from 'vitest';
import { formatLegacyOsSlug } from '../format-os';

describe('formatLegacyOsSlug', () => {
  it('maps known legacy slugs to display names', () => {
    expect(formatLegacyOsSlug('ubuntu2004')).toBe('Ubuntu 20.04');
    expect(formatLegacyOsSlug('ubuntu-20-04')).toBe('Ubuntu 20.04');
    expect(formatLegacyOsSlug('ubuntu2204')).toBe('Ubuntu 22.04');
    expect(formatLegacyOsSlug('ubuntu-22-04')).toBe('Ubuntu 22.04');
  });

  it('passes unknown slugs through unchanged', () => {
    expect(formatLegacyOsSlug('debian-bookworm-vanilla')).toBe('debian-bookworm-vanilla');
    expect(formatLegacyOsSlug('ubuntu-noble-vanilla')).toBe('ubuntu-noble-vanilla');
  });

  it('returns undefined for null or undefined input', () => {
    expect(formatLegacyOsSlug(null)).toBeUndefined();
    expect(formatLegacyOsSlug(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(formatLegacyOsSlug('')).toBeUndefined();
  });
});
