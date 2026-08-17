// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CONCEPT_ENTRIES } from './concepts';
import { DATA_ENTRIES } from './data';
import { HOW_TO_ENTRIES } from './how-to';
import { getWikiEntry, WIKI, WIKI_LIST } from './index';
import { NAVIGATION_ENTRIES } from './navigation';
import { SERVICE_ENTRIES } from './services';
import type { WikiEntry } from './types';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
}));

const MODULES: [string, WikiEntry['category'], WikiEntry[], number][] = [
  ['concepts', 'Concepts', CONCEPT_ENTRIES, 13],
  ['navigation', 'Navigation', NAVIGATION_ENTRIES, 8],
  ['services', 'Services', SERVICE_ENTRIES, 1],
  ['data', 'Data', DATA_ENTRIES, 5],
  ['how-to', 'How-to', HOW_TO_ENTRIES, 6],
];

describe('wiki registry', () => {
  it('holds every entry', () => {
    expect(WIKI_LIST).toHaveLength(33);
  });

  it('has unique slugs', () => {
    const slugs = WIKI_LIST.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keys WIKI by slug for every entry', () => {
    expect(Object.keys(WIKI)).toHaveLength(WIKI_LIST.length);
    for (const entry of WIKI_LIST) {
      expect(WIKI[entry.slug]).toBe(entry);
      expect(getWikiEntry(entry.slug)).toBe(entry);
    }
  });

  it.each(MODULES)('files every %s entry under its own category', (_name, category, entries, size) => {
    expect(entries).toHaveLength(size);
    for (const entry of entries) {
      expect(entry.category, entry.slug).toBe(category);
    }
  });

  it('composes the registry from exactly the per-category modules', () => {
    expect(WIKI_LIST).toHaveLength(MODULES.reduce((n, [, , entries]) => n + entries.length, 0));
  });

  it('resolves every related slug to a real entry', () => {
    for (const entry of WIKI_LIST) {
      for (const slug of entry.related ?? []) {
        expect(getWikiEntry(slug), `${entry.slug} → ${slug}`).toBeDefined();
      }
    }
  });

  it('gives every entry a title, brief, and a body that renders visible text', () => {
    for (const entry of WIKI_LIST) {
      expect(entry.title.trim()).not.toBe('');
      expect(entry.brief.trim()).not.toBe('');
      const { container, unmount } = render(entry.body);
      expect(container.textContent?.trim(), entry.slug).not.toBe('');
      unmount();
    }
  });

  it('returns undefined for an unknown slug', () => {
    expect(getWikiEntry('nope')).toBeUndefined();
  });
});
