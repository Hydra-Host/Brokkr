import { describe, expect, it } from 'vitest';
import { isTeeRequested } from '../tee-requested';

describe('isTeeRequested', () => {
  it('returns true when the explicit tee flag is set', () => {
    expect(isTeeRequested(true, 'ubuntu-noble-vanilla', null)).toBe(true);
  });

  it('returns false when no tee signal is present', () => {
    expect(isTeeRequested(false, 'ubuntu-noble-vanilla', null)).toBe(false);
  });

  it('returns false when tee flag is undefined and no other signal', () => {
    expect(isTeeRequested(undefined, 'ubuntu-noble-hpc', [])).toBe(false);
  });

  it('returns true when the os slug has a tee variant', () => {
    expect(isTeeRequested(false, 'ubuntu-noble-tee', null)).toBe(true);
  });

  it('returns true when customizations include the tee-setup slug', () => {
    expect(isTeeRequested(false, 'ubuntu-noble-vanilla', ['tee-setup'])).toBe(true);
  });

  it('returns true when multiple signals overlap', () => {
    expect(isTeeRequested(true, 'ubuntu-noble-tee', ['tee-setup'])).toBe(true);
  });

  it('ignores unrelated customizations', () => {
    expect(isTeeRequested(false, 'ubuntu-noble-vanilla', ['gpu-driver', 'cuda-toolkit'])).toBe(false);
  });

  it('handles null customizations', () => {
    expect(isTeeRequested(false, 'ubuntu-noble-vanilla', null)).toBe(false);
  });

  it('handles undefined customizations', () => {
    expect(isTeeRequested(false, 'ubuntu-noble-vanilla', undefined)).toBe(false);
  });
});
