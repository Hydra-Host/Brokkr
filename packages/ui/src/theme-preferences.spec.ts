import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_STORAGE_KEYS,
  LEGACY_THEME_AXES,
  STORAGE_KEYS,
  loadPreferences,
  migrateLegacyPreferences,
  type Preferences,
} from './components/theme-provider';

const DEFAULTS: Preferences = { style: 'modern', color: 'blue', mode: 'light' };

const originalMatchMedia = window.matchMedia;

function stubPrefersLight(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function storedNewKeys() {
  return {
    style: localStorage.getItem(STORAGE_KEYS.STYLE),
    color: localStorage.getItem(STORAGE_KEYS.COLOR),
    mode: localStorage.getItem(STORAGE_KEYS.MODE),
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
});

describe('migrateLegacyPreferences', () => {
  it.each(Object.entries(LEGACY_THEME_AXES))('maps legacy theme %s onto the axes', (id, axes) => {
    localStorage.setItem('brokkr-theme', id);
    expect(migrateLegacyPreferences()).toEqual(axes);
  });

  it('returns null when no legacy theme is stored', () => {
    expect(migrateLegacyPreferences()).toBeNull();
  });

  it('returns null for an unknown legacy theme', () => {
    localStorage.setItem('brokkr-theme', 'nope');
    expect(migrateLegacyPreferences()).toBeNull();
  });

  it('keeps system mode and takes the axes from the preferred theme of the current OS side', () => {
    localStorage.setItem('brokkr-theme', 'system');
    localStorage.setItem('brokkr-preferred-light', 'commerce-light');
    localStorage.setItem('brokkr-preferred-dark', 'yellow');
    stubPrefersLight(true);
    expect(migrateLegacyPreferences()).toEqual({ style: 'modern', color: 'violet', mode: 'system' });
    stubPrefersLight(false);
    expect(migrateLegacyPreferences()).toEqual({ style: 'retro', color: 'gold', mode: 'system' });
  });

  it('falls back to hydra-dark when system mode has no preferred theme', () => {
    localStorage.setItem('brokkr-theme', 'system');
    stubPrefersLight(true);
    expect(migrateLegacyPreferences()).toEqual({ style: 'retro', color: 'violet', mode: 'system' });
  });

  it('treats a missing matchMedia as dark', () => {
    localStorage.setItem('brokkr-theme', 'system');
    localStorage.setItem('brokkr-preferred-light', 'commerce-light');
    localStorage.setItem('brokkr-preferred-dark', 'green');
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true, writable: true });
    expect(migrateLegacyPreferences()).toEqual({ style: 'retro', color: 'green', mode: 'system' });
  });
});

describe('loadPreferences', () => {
  it('uses defaults and persists nothing when storage is empty', () => {
    expect(loadPreferences(DEFAULTS)).toEqual(DEFAULTS);
    expect(storedNewKeys()).toEqual({ style: null, color: null, mode: null });
  });

  it('reads the new keys and ignores invalid values', () => {
    localStorage.setItem(STORAGE_KEYS.STYLE, 'retro');
    localStorage.setItem(STORAGE_KEYS.COLOR, 'teal');
    localStorage.setItem(STORAGE_KEYS.MODE, 'system');
    expect(loadPreferences(DEFAULTS)).toEqual({ style: 'retro', color: 'blue', mode: 'system' });
  });

  it('migrates a legacy theme and re-persists it under the new keys', () => {
    localStorage.setItem('brokkr-theme', 'pink');
    expect(loadPreferences(DEFAULTS)).toEqual({ style: 'retro', color: 'pink', mode: 'dark' });
    expect(storedNewKeys()).toEqual({ style: 'retro', color: 'pink', mode: 'dark' });
  });

  it('skips migration when any new key is already set', () => {
    localStorage.setItem(STORAGE_KEYS.STYLE, 'retro');
    localStorage.setItem('brokkr-theme', 'pink');
    expect(loadPreferences(DEFAULTS)).toEqual({ style: 'retro', color: 'blue', mode: 'light' });
    expect(storedNewKeys()).toEqual({ style: 'retro', color: null, mode: null });
  });

  it('falls back to defaults for an unknown legacy theme without persisting', () => {
    localStorage.setItem('brokkr-theme', 'nope');
    expect(loadPreferences(DEFAULTS)).toEqual(DEFAULTS);
    expect(storedNewKeys()).toEqual({ style: null, color: null, mode: null });
  });

  it.each([
    ['a known legacy theme', 'blue'],
    ['an unknown legacy theme', 'nope'],
    ['system mode', 'system'],
  ])('removes every legacy key after loading with %s', (_label, theme) => {
    for (const key of LEGACY_STORAGE_KEYS) localStorage.setItem(key, theme);
    loadPreferences(DEFAULTS);
    for (const key of LEGACY_STORAGE_KEYS) expect(localStorage.getItem(key)).toBeNull();
  });
});
