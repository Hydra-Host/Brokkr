import { describe, expect, it } from 'vitest';
import { emptyCustomizations } from '../customization-layers';

describe('emptyCustomizations', () => {
  it('builds an empty value per catalog group slug across bases, including tee', () => {
    const catalog = {
      'ubuntu-noble': [
        { slug: 'gpuDriver', selectionType: 'SINGLE_SELECT' },
        { slug: 'miscSoftware', selectionType: 'MULTI_SELECT' },
      ],
      'ubuntu-jammy': [{ slug: 'tee', selectionType: 'SINGLE_SELECT' }],
    };
    expect(emptyCustomizations(catalog)).toEqual({ gpuDriver: '', miscSoftware: [], tee: '' });
  });

  it('returns {} for a catalog with no component layers', () => {
    expect(emptyCustomizations({})).toEqual({});
  });

  it('returns a fresh array per call for a MULTI_SELECT group', () => {
    const catalog = { base: [{ slug: 'miscSoftware', selectionType: 'MULTI_SELECT' }] };
    expect(emptyCustomizations(catalog).miscSoftware).not.toBe(emptyCustomizations(catalog).miscSoftware);
  });
});
