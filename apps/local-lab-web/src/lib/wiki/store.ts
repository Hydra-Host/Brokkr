import type { WikiEntry } from './types';

let registry: Record<string, WikiEntry> = {};

/** Graph leaf: entry modules render `WikiLink`, which must resolve slugs without importing the index that builds them. */
export function setWikiRegistry(entries: Record<string, WikiEntry>): void {
  registry = entries;
}

export function getWikiEntry(slug: string): WikiEntry | undefined {
  return registry[slug];
}
