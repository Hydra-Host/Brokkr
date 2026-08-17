import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WikiEntry } from './types';

const CATEGORIES: [string, () => Promise<WikiEntry[]>][] = [
  ['concepts', async () => (await import('./concepts')).CONCEPT_ENTRIES],
  ['navigation', async () => (await import('./navigation')).NAVIGATION_ENTRIES],
  ['services', async () => (await import('./services')).SERVICE_ENTRIES],
  ['data', async () => (await import('./data')).DATA_ENTRIES],
  ['how-to', async () => (await import('./how-to')).HOW_TO_ENTRIES],
];

describe('wiki module graph', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each(CATEGORIES)('resolves the registry with %s evaluated before the index', async (_name, load) => {
    const entries = await load();
    expect(entries.length).toBeGreaterThan(0);

    const { getWikiEntry, WIKI, WIKI_LIST } = await import('./index');
    for (const entry of entries) {
      expect(WIKI_LIST, entry.slug).toContain(entry);
      expect(WIKI[entry.slug], entry.slug).toBe(entry);
      expect(getWikiEntry(entry.slug), entry.slug).toBe(entry);
    }
  });
});
