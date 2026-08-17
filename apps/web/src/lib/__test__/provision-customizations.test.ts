import { type CustomizationLayer } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPERATING_SYSTEM,
  emptyCustomizations,
  flattenCustomizationsForSubmit,
  osCandidateForMode,
  reprovisionTeeDefault,
  resolveOperatingSystemSlug,
  shouldShowTeeCheckbox,
} from '../provision-customizations';

function group(slug: string, selectionType: CustomizationLayer['selectionType']): CustomizationLayer {
  return { slug, name: slug, selectionType, options: [] };
}

describe('emptyCustomizations', () => {
  it('builds an empty value per catalog group slug, including tee', () => {
    const catalog = {
      'ubuntu-noble': [group('gpuDriver', 'SINGLE_SELECT'), group('miscSoftware', 'MULTI_SELECT')],
      'ubuntu-jammy': [group('tee', 'SINGLE_SELECT')],
    };
    expect(emptyCustomizations(catalog)).toEqual({ gpuDriver: '', miscSoftware: [], tee: '' });
  });

  it('returns {} for a device with no component layers', () => {
    expect(emptyCustomizations({})).toEqual({});
  });
});

describe('osCandidateForMode', () => {
  const baseLayers = [{ slug: 'ubuntu-noble' }, { slug: 'ubuntu-jammy' }];

  it('picks the first base layer slug', () => {
    expect(osCandidateForMode(baseLayers)).toBe('ubuntu-noble');
  });

  it('returns "" when the list is empty', () => {
    expect(osCandidateForMode([])).toBe('');
  });
});

describe('resolveOperatingSystemSlug', () => {
  it('returns a well-formed candidate unchanged', () => {
    expect(resolveOperatingSystemSlug('ubuntu-noble-vanilla', DEFAULT_OPERATING_SYSTEM)).toBe('ubuntu-noble-vanilla');
  });

  it('falls back when the candidate is empty or malformed', () => {
    expect(resolveOperatingSystemSlug('', DEFAULT_OPERATING_SYSTEM)).toBe(DEFAULT_OPERATING_SYSTEM);
    expect(resolveOperatingSystemSlug('Has Spaces', DEFAULT_OPERATING_SYSTEM)).toBe(DEFAULT_OPERATING_SYSTEM);
  });

  it('default-OS resolution mirrors the form: first base layer slug, fallback when empty', () => {
    const baseLayers = [{ slug: 'ubuntu-noble' }];
    expect(resolveOperatingSystemSlug(osCandidateForMode(baseLayers), DEFAULT_OPERATING_SYSTEM)).toBe('ubuntu-noble');
    expect(resolveOperatingSystemSlug(osCandidateForMode([]), DEFAULT_OPERATING_SYSTEM)).toBe(DEFAULT_OPERATING_SYSTEM);
  });
});

describe('flattenCustomizationsForSubmit', () => {
  it('returns null when there are no values', () => {
    expect(flattenCustomizationsForSubmit(undefined)).toBeNull();
  });

  it('returns null when every group is empty', () => {
    expect(flattenCustomizationsForSubmit({ gpuDriver: '', miscSoftware: [], tee: '' })).toBeNull();
  });

  it('drops empty groups and keeps populated ones, including a selected tee layer', () => {
    expect(
      flattenCustomizationsForSubmit({
        gpuDriver: 'nvidia-driver-580',
        gpuFramework: '',
        miscSoftware: ['docker', 'ollama'],
        tee: 'tee-setup',
      }),
    ).toEqual({ gpuDriver: 'nvidia-driver-580', miscSoftware: ['docker', 'ollama'], tee: 'tee-setup' });
  });
});

describe('shouldShowTeeCheckbox', () => {
  it('returns true only for iPXE-Custom OS slugs with a TEE-capable device', () => {
    expect(shouldShowTeeCheckbox('ipxe-custom', true)).toBe(true);
    expect(shouldShowTeeCheckbox('ipxe-custom-tee', true)).toBe(true);
  });

  it('returns false when the OS is not iPXE-Custom', () => {
    expect(shouldShowTeeCheckbox('ubuntu-noble-vanilla', true)).toBe(false);
  });

  it('returns false when the device is not TEE-capable', () => {
    expect(shouldShowTeeCheckbox('ipxe-custom', false)).toBe(false);
  });

  it('returns false when neither condition is met', () => {
    expect(shouldShowTeeCheckbox('ubuntu-noble-vanilla', false)).toBe(false);
  });
});

describe('reprovisionTeeDefault', () => {
  it('returns true when all three conditions hold', () => {
    expect(reprovisionTeeDefault('ipxe-custom', true, true)).toBe(true);
  });

  it('returns false when OS is not iPXE-Custom', () => {
    expect(reprovisionTeeDefault('ubuntu-noble-vanilla', true, true)).toBe(false);
  });

  it('returns false when device is not TEE-capable', () => {
    expect(reprovisionTeeDefault('ipxe-custom', false, true)).toBe(false);
  });

  it('returns false when teeEnabled is false', () => {
    expect(reprovisionTeeDefault('ipxe-custom', true, false)).toBe(false);
  });

  it('returns false when teeEnabled is null or undefined', () => {
    expect(reprovisionTeeDefault('ipxe-custom', true, null)).toBe(false);
    expect(reprovisionTeeDefault('ipxe-custom', true, undefined)).toBe(false);
  });
});
