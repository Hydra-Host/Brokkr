import { describe, expect, it } from 'vitest';

import { blocksUnsavedNav, canSaveForm, shouldHydrateForm } from './unsaved-nav';

describe('blocksUnsavedNav', () => {
  it('never blocks with nothing unsaved', () => {
    expect(blocksUnsavedNav(false, '/settings', '/fleet')).toBe(false);
    expect(blocksUnsavedNav(false, '/settings', '/settings')).toBe(false);
  });

  it('blocks a route change while dirty', () => {
    expect(blocksUnsavedNav(true, '/settings', '/fleet')).toBe(true);
    expect(blocksUnsavedNav(true, '/settings', '/settings/fleet')).toBe(true);
  });

  it('lets a re-navigation to the current route through', () => {
    expect(blocksUnsavedNav(true, '/settings', '/settings')).toBe(false);
  });

  it('ignores a trailing-slash-only difference', () => {
    expect(blocksUnsavedNav(true, '/settings', '/settings/')).toBe(false);
    expect(blocksUnsavedNav(true, '/settings/', '/settings')).toBe(false);
    expect(blocksUnsavedNav(true, '/', '/')).toBe(false);
  });

  it('blocks navigation to the root from a nested route', () => {
    expect(blocksUnsavedNav(true, '/settings', '/')).toBe(true);
  });
});

describe('shouldHydrateForm', () => {
  it('hydrates the first response even when an edit landed while it was in flight', () => {
    expect(shouldHydrateForm(false, true)).toBe(true);
    expect(shouldHydrateForm(false, false)).toBe(true);
  });

  it('lets a later refetch overwrite the form only when nothing is unsaved', () => {
    expect(shouldHydrateForm(true, false)).toBe(true);
    expect(shouldHydrateForm(true, true)).toBe(false);
  });
});

describe('canSaveForm', () => {
  it('refuses to save a form that never hydrated', () => {
    expect(canSaveForm(false, true, false)).toBe(false);
    expect(canSaveForm(false, false, false)).toBe(false);
  });

  it('saves unsaved edits once hydrated', () => {
    expect(canSaveForm(true, true, false)).toBe(true);
  });

  it('refuses with nothing changed or a save already in flight', () => {
    expect(canSaveForm(true, false, false)).toBe(false);
    expect(canSaveForm(true, true, true)).toBe(false);
  });
});
