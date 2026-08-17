import { CONCEPT_ENTRIES } from './concepts';
import { DATA_ENTRIES } from './data';
import { HOW_TO_ENTRIES } from './how-to';
import { NAVIGATION_ENTRIES } from './navigation';
import { SERVICE_ENTRIES } from './services';
import { getWikiEntry, setWikiRegistry } from './store';
import type { WikiEntry } from './types';

/** Another agent depends on the exported shape (`WikiEntry`, `WIKI`, `WIKI_LIST`, `getWikiEntry`) — don't change it without coordinating. */
export { getWikiEntry };
export type { WikiEntry };

const ENTRIES: WikiEntry[] = [
  ...CONCEPT_ENTRIES,
  ...NAVIGATION_ENTRIES,
  ...SERVICE_ENTRIES,
  ...DATA_ENTRIES,
  ...HOW_TO_ENTRIES,
];

export const WIKI_LIST: WikiEntry[] = ENTRIES;

export const WIKI: Record<string, WikiEntry> = Object.fromEntries(ENTRIES.map((e) => [e.slug, e]));

setWikiRegistry(WIKI);
