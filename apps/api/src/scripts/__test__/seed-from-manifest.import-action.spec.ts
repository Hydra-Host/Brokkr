import { LayerBuildStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { resolveImportAction } from '../layers/resolve-import-action';

describe('resolveImportAction', () => {
  it('returns CREATE when no existing build exists', () => {
    expect(resolveImportAction(null)).toBe('CREATE');
  });

  it('returns REIMPORT for a stale IMPORTING build', () => {
    expect(resolveImportAction(LayerBuildStatus.IMPORTING)).toBe('REIMPORT');
  });

  it('returns REIMPORT for a FAILED build', () => {
    expect(resolveImportAction(LayerBuildStatus.FAILED)).toBe('REIMPORT');
  });

  it('throws for a READY build (immutability guard)', () => {
    expect(() => resolveImportAction(LayerBuildStatus.READY)).toThrow(/Cannot re-import.*status=READY/);
  });

  it('throws for a RETIRED build', () => {
    expect(() => resolveImportAction(LayerBuildStatus.RETIRED)).toThrow(/Cannot re-import.*status=RETIRED/);
  });
});
