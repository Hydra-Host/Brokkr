// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { leafAnchor, leafPath, SECTIONS, type Leaf } from '@/components/app-sidebar';
import { ApplyClassSchema } from '@/contract';

import { DEPLOY_STEPS, OPS_STEPS, ORIENTATION_STEPS, type TourStep } from './tour-steps';
import { getWikiEntry, WIKI_LIST } from './wiki';
import type { WikiEntry } from './wiki/types';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
}));

const LEAVES: Leaf[] = SECTIONS.flatMap((s) => s.leaves);

function htmlText(html: string): string {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.textContent ?? '';
}

const stepText = (step: TourStep): string => `${step.title} ${htmlText(step.description)}`;

function entryText(entry: WikiEntry): string {
  const { container, unmount } = render(entry.body);
  const body = container.textContent ?? '';
  unmount();
  return `${entry.title} ${entry.brief} ${body}`;
}

const ALL_STEPS: [string, TourStep][] = [
  ...ORIENTATION_STEPS.map((s, i): [string, TourStep] => [`orientation step ${i}`, s]),
  ...DEPLOY_STEPS.map((s, i): [string, TourStep] => [`deploy step ${i}`, s]),
  ...OPS_STEPS.map((s, i): [string, TourStep] => [`ops step ${i}`, s]),
];

const DOCS: [string, string][] = [
  ...ALL_STEPS.map(([label, step]): [string, string] => [label, stepText(step)]),
  ...WIKI_LIST.map((e): [string, string] => [`wiki ${e.slug}`, entryText(e)]),
];

export const WIKI_ENTRY_FOR_NAV_LEAF: Record<string, string> = {
  '/': 'overview',
  '/stack': 'local-environment',
  '/datastore': 'datastore',
  '/hub': 'hub-page',
  '/storage': 'storage',
  '/fleet': 'fleet',
  '/layers': 'layers',
  '/testing': 'testing',
  '/results': 'results',
  '/config': 'config',
  '/config/fleet': 'fleet-builder',
  '/config/zones': 'fleet-topology',
  '/config/advanced': 'config-advanced',
  '/docs': 'api-docs',
  '/audit': 'audit',
};

export const NAV_LEAVES_THAT_ARE_THEMSELVES_THE_DOCUMENTATION = [
  '/getting-started',
  '/wiki',
  '/wiki/bring-up',
  '/wiki/running-the-stack',
];

function orientationVisits(): Set<string> {
  const pathByAnchor = new Map(LEAVES.map((l) => [leafAnchor(l), leafPath(l)]));
  return new Set(
    ORIENTATION_STEPS.flatMap((step) => {
      const match = /^\[data-tour="([\w-]+)"\]$/.exec(step.element ?? '');
      const byAnchor = match ? pathByAnchor.get(match[1]!) : undefined;
      return [byAnchor, step.route].flatMap((path) => (path ? [path] : []));
    }),
  );
}

describe('nav to wiki coverage', () => {
  it('documents every nav leaf in the wiki, in the tour, or by being documentation', () => {
    const visited = orientationVisits();
    const undocumented = LEAVES.filter((leaf) => {
      const path = leafPath(leaf);
      if (WIKI_ENTRY_FOR_NAV_LEAF[path]) return false;
      if (visited.has(path)) return false;
      return !NAV_LEAVES_THAT_ARE_THEMSELVES_THE_DOCUMENTATION.includes(path);
    }).map((leaf) => `${leaf.label} (${leafPath(leaf)})`);
    expect(undocumented).toEqual([]);
  });

  it('maps every nav leaf onto a wiki entry that exists', () => {
    for (const [path, slug] of Object.entries(WIKI_ENTRY_FOR_NAV_LEAF)) {
      expect(getWikiEntry(slug), `${path} → ${slug}`).toBeDefined();
    }
  });

  it('keeps no path the sidebar no longer has', () => {
    const paths = new Set(LEAVES.map(leafPath));
    const stale = [
      ...Object.keys(WIKI_ENTRY_FOR_NAV_LEAF),
      ...NAV_LEAVES_THAT_ARE_THEMSELVES_THE_DOCUMENTATION,
      ...NAV_LEAVES_THE_ORIENTATION_TOUR_NEVER_VISITS,
    ].filter((path) => !paths.has(path));
    expect(stale).toEqual([]);
  });
});

export const NAV_GROUP_SUMMARY_ANCHOR = '[data-tour="sidebar-rail"]';

export const NAV_LEAVES_THE_ORIENTATION_TOUR_NEVER_VISITS = [
  '/getting-started',
  '/wiki',
  '/wiki/bring-up',
  '/wiki/running-the-stack',
];

function positionsOf(text: string, phrases: string[]): number[] {
  const byLength = [...phrases].sort((a, b) => b.length - a.length);
  const at = new Map<string, number>();
  let masked = text;
  for (const phrase of byLength) {
    const index = masked.indexOf(phrase);
    at.set(phrase, index);
    if (index >= 0) {
      masked = masked.slice(0, index) + ' '.repeat(phrase.length) + masked.slice(index + phrase.length);
    }
  }
  return phrases.map((phrase) => at.get(phrase) ?? -1);
}

describe('nav to tour coverage', () => {
  it('names every sidebar group, in sidebar order, on the step that introduces the rail', () => {
    const step = ALL_STEPS.map(([, s]) => s).find((s) => s.element === NAV_GROUP_SUMMARY_ANCHOR);
    expect(step, NAV_GROUP_SUMMARY_ANCHOR).toBeDefined();
    const titles = SECTIONS.map((s) => s.title);
    const at = positionsOf(stepText(step!), titles);
    expect(titles.filter((_, i) => at[i]! < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('names every child page, in sidebar order, on the step that introduces their parent', () => {
    for (const section of SECTIONS) {
      for (const parent of section.leaves) {
        const children = section.leaves.filter((l) => leafPath(l).startsWith(`${leafPath(parent)}/`));
        if (children.length === 0) continue;
        const step = ORIENTATION_STEPS.find((s) => s.element === `[data-tour="${leafAnchor(parent)}"]`);
        if (!step) continue;
        const labels = children.map((l) => l.label);
        const at = positionsOf(stepText(step), labels);
        expect(
          labels.filter((_, i) => at[i]! < 0),
          parent.label,
        ).toEqual([]);
        expect(
          [...at].sort((a, b) => a - b),
          parent.label,
        ).toEqual(at);
      }
    }
  });

  it('highlights the nav items it does highlight in sidebar order', () => {
    const pathByAnchor = new Map(LEAVES.map((l) => [leafAnchor(l), leafPath(l)]));
    const highlighted = ORIENTATION_STEPS.flatMap((step) => {
      const match = /^\[data-tour="([\w-]+)"\]$/.exec(step.element ?? '');
      const path = match ? pathByAnchor.get(match[1]!) : undefined;
      return path ? [path] : [];
    });
    const inSidebarOrder = LEAVES.map(leafPath).filter((path) => highlighted.includes(path));
    expect(highlighted).toEqual(inSidebarOrder);
  });

  it('visits every nav leaf it does not declare as unvisited', () => {
    const visited = orientationVisits();
    const missed = LEAVES.map(leafPath).filter(
      (path) => !visited.has(path) && !NAV_LEAVES_THE_ORIENTATION_TOUR_NEVER_VISITS.includes(path),
    );
    expect(missed).toEqual([]);
  });
});

const README = z
  .string()
  .parse(Object.values(import.meta.glob('../../README.md', { query: '?raw', import: 'default', eager: true }))[0]);

export const README_ROUTE_ROWS = /^\|[^|]*\|\s*`([^`]+)`\s*\|/gm;

describe('the README route table', () => {
  it('lists every nav route, and no route the nav dropped', () => {
    const documented = [...README.matchAll(README_ROUTE_ROWS)].map((m) => m[1]!);
    const navigable = LEAVES.map((l) => (l.params ? '/wiki/$slug' : l.to));
    expect([...new Set(documented)].sort()).toEqual([...new Set(navigable)].sort());
  });

  it('names every nav group', () => {
    for (const section of SECTIONS) {
      expect(README, section.title).toContain(`**${section.title}**`);
    }
  });
});

export const RETIRED_PROSE: [string, RegExp][] = [
  ['the /settings route that redirects away', /\/settings\b/],
  ['Settings as a place in the app', /\bSettings\b/],
  ['Config, where the group is Configuration', /\bConfig\b/],
  ['a zone called a data center', /\bdata[\s-]?centre?s?\b/i],
  ['the Fleet Builder, which is now the Fleet nodes page', /\bFleet Builder\b/],
];

export const NAV_LABELS_OF_SURFACES_THAT_REALLY_HAVE_TABS = ['Datastore', 'Hub'];

describe('retired terminology', () => {
  it.each(RETIRED_PROSE)('never says %s', (_reason, pattern) => {
    expect(DOCS.filter(([, text]) => pattern.test(text)).map(([label]) => label)).toEqual([]);
  });

  it('never calls a page a tab', () => {
    const pages = LEAVES.map((l) => l.label).filter(
      (label) => !NAV_LABELS_OF_SURFACES_THAT_REALLY_HAVE_TABS.includes(label),
    );
    const hits = DOCS.flatMap(([label, text]) =>
      pages
        .filter((page) => new RegExp(`\\b${page}\\b\\s+tabs?\\b`, 'i').test(text))
        .map((page) => `${label}: ${page} tab`),
    );
    expect(hits).toEqual([]);
  });

  it('never links the retired route from a raw description string', () => {
    const linking = ALL_STEPS.filter(([, step]) => /\/settings\b/.test(step.description)).map(([label]) => label);
    expect(linking).toEqual([]);
  });
});

export const WIKI_ENTRY_ENUMERATING_APPLY_CLASSES = 'apply';

export const APPLY_CLASS_PROSE: Record<string, RegExp> = {
  inert: /inert/i,
  auto: /already applied on save/i,
  'reload-hub': /hub reload/i,
  'reload-spoke': /spoke reload/i,
  redeploy: /redeploy/i,
  'fleet-op': /fleet apply/i,
  'rebind-recreate': /full recreation/i,
  reslot: /slot/i,
  'zone-apply': /zone seed/i,
  'datastore-reset': /datastore reset/i,
};

describe('apply classes', () => {
  it('gives every contract class a phrase to look for', () => {
    expect(Object.keys(APPLY_CLASS_PROSE).sort()).toEqual([...ApplyClassSchema.options].sort());
  });

  it('names every contract class in the apply entry', () => {
    const entry = getWikiEntry(WIKI_ENTRY_ENUMERATING_APPLY_CLASSES);
    expect(entry, WIKI_ENTRY_ENUMERATING_APPLY_CLASSES).toBeDefined();
    const text = entryText(entry!);
    const missing = ApplyClassSchema.options.filter((cls) => !APPLY_CLASS_PROSE[cls]!.test(text));
    expect(missing).toEqual([]);
  });
});
