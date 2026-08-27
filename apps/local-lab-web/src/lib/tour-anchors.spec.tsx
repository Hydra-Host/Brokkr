// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppSidebar, leafAnchor, SECTIONS, type Leaf } from '@/components/app-sidebar';
import { AREA_SECTIONS, KNOB_PREFIXES, knobLocation } from '@/features/config/knob-location';
import { validateAuditSearch } from '@/lib/audit-search';
import { validateDatastoreSearch } from '@/lib/datastore-search';
import { validateHubSearch } from '@/lib/hub-search';
import { validateStackSearch } from '@/lib/stack-search';

import { DEPLOY_STEPS, OPS_STEPS, ORIENTATION_STEPS, type TourStep } from './tour-steps';

interface LinkStub {
  to?: string;
  params?: { slug: string };
  children?: ReactNode;
  title?: string;
  className?: string;
  'data-tour'?: string;
}

vi.mock('@/lib/api', () => ({
  tsr: { listAppLinks: { useQuery: () => ({ data: undefined }) } },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useLocation: () => ({ pathname: '/' }),
  Link: ({ to, params, children, ...rest }: LinkStub) => (
    <a href={params ? `/wiki/${params.slug}` : to} {...rest}>
      {children}
    </a>
  ),
}));

const SOURCE = z
  .record(z.string(), z.string())
  .parse(import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }));

const APP_SOURCE = Object.entries(SOURCE).filter(([path]) => !path.includes('.spec.'));
const ROUTE_SOURCE = APP_SOURCE.filter(([path]) => path.startsWith('../routes/'));

const ANCHOR = z.string().regex(/^[A-Za-z][\w-]*$/);

function attributeLiterals(attr: string): Set<string> {
  const found = new Set<string>();
  for (const [, text] of APP_SOURCE) {
    for (const [, value] of text.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      const parsed = ANCHOR.safeParse(value);
      if (parsed.success) found.add(parsed.data);
    }
  }
  return found;
}

const LEAVES: Leaf[] = SECTIONS.flatMap((s) => s.leaves);

const TOUR_ANCHORS = new Set([...attributeLiterals('data-tour'), ...LEAVES.map(leafAnchor)]);

const AREA_BY_ROUTE = new Map(
  KNOB_PREFIXES.flatMap((prefix) => {
    const where = knobLocation(prefix);
    return where ? [[where.route, where.area] as const] : [];
  }),
);

const DECKS: [string, TourStep[]][] = [
  ['orientation', ORIENTATION_STEPS],
  ['deploy', DEPLOY_STEPS],
  ['ops', OPS_STEPS],
];

function keptValue(validated: object, key: string): unknown {
  return Object.entries(validated).find(([k]) => k === key)?.[1];
}

const anchored = (steps: TourStep[]) =>
  steps.flatMap((step, index) => (step.element ? [{ index, selector: step.element, route: step.route }] : []));

export const FILES_BUILDING_A_TOUR_ANCHOR_FROM_AN_EXPRESSION = ['../components/app-sidebar.tsx'];

describe.each(DECKS)('%s selectors', (_deck, steps) => {
  it('uses only the two selector forms this guard can resolve', () => {
    for (const t of anchored(steps)) {
      expect(t.selector, `step ${t.index}`).toMatch(/^(\[data-tour="[\w-]+"\]|#[\w-]+)$/);
    }
  });

  it('names a data-tour anchor the app renders', () => {
    for (const t of anchored(steps)) {
      const match = /^\[data-tour="([\w-]+)"\]$/.exec(t.selector);
      if (!match) continue;
      expect([...TOUR_ANCHORS], `step ${t.index} → ${t.selector}`).toContain(match[1]);
    }
  });

  it('names a rail section its own route owns, or an id the app renders', () => {
    for (const t of anchored(steps)) {
      const match = /^#([\w-]+)$/.exec(t.selector);
      if (!match) continue;
      const area = AREA_BY_ROUTE.get(t.route ?? '');
      const resolvable = new Set([...(area ? AREA_SECTIONS[area] : []), ...attributeLiterals('id')]);
      expect([...resolvable], `step ${t.index} → ${t.selector} on route ${t.route}`).toContain(match[1]);
    }
  });

  it('never anchors a knob row the changed-only filter can hide', () => {
    for (const t of anchored(steps)) {
      expect(t.selector.startsWith('#cfg-'), `step ${t.index} → ${t.selector}`).toBe(false);
    }
  });
});

describe('generated anchors', () => {
  it('builds an anchor from an expression only where this spec renders the result', () => {
    const generated = APP_SOURCE.filter(([, text]) => text.includes('data-tour={')).map(([path]) => path);
    expect(generated.sort()).toEqual([...FILES_BUILDING_A_TOUR_ANCHOR_FROM_AN_EXPRESSION].sort());
  });

  it('renders every sidebar anchor the leaf derivation promises', () => {
    const { container, unmount } = render(<AppSidebar open setOpen={() => {}} />);
    const rendered = new Set([...container.querySelectorAll('[data-tour]')].map((el) => el.getAttribute('data-tour')));
    unmount();
    for (const leaf of LEAVES) expect([...rendered], leaf.label).toContain(leafAnchor(leaf));
  });
});

const ROUTE_IDS = z
  .array(z.string().startsWith('/'))
  .parse(ROUTE_SOURCE.flatMap(([, text]) => [...text.matchAll(/createFileRoute\('([^']+)'\)/g)].map((m) => m[1])));

const NAVIGABLE = new Set(ROUTE_IDS.map((id) => (id === '/' ? id : id.replace(/\/$/, ''))));

export const ROUTES_RETIRED_TO_A_REDIRECT_SHIM = ['/settings'];

export const SEARCH_VALIDATORS: Record<string, (search: Record<string, unknown>) => object> = {
  '/stack': validateStackSearch,
  '/datastore': validateDatastoreSearch,
  '/hub': validateHubSearch,
  '/audit': validateAuditSearch,
};

export const ROUTES_VALIDATING_SEARCH_INLINE = ['/config/fleet'];

describe.each(DECKS)('%s routes', (_deck, steps) => {
  it('sits on a route the router registers, and never on a retired shim', () => {
    steps.forEach((step, index) => {
      if (!step.route) return;
      expect([...NAVIGABLE], `step ${index}`).toContain(step.route);
      expect(ROUTES_RETIRED_TO_A_REDIRECT_SHIM, `step ${index}`).not.toContain(step.route);
      expect(step.route.includes('$'), `step ${index} needs route params the tour cannot carry`).toBe(false);
    });
  });

  it('sets only search params its route keeps', () => {
    steps.forEach((step, index) => {
      if (!step.search) return;
      const validate = SEARCH_VALIDATORS[step.route ?? ''];
      expect(validate, `step ${index} on ${step.route}`).toBeDefined();
      const kept = validate?.(step.search) ?? {};
      for (const [key, value] of Object.entries(step.search)) {
        expect(keptValue(kept, key), `step ${index} → ${key}=${value}`).toBe(value);
      }
    });
  });
});

describe('search validators', () => {
  it('names a validator for every route that declares one', () => {
    const declaring = ROUTE_SOURCE.filter(([, text]) => text.includes('validateSearch')).flatMap(([, text]) =>
      [...text.matchAll(/createFileRoute\('([^']+)'\)/g)].map((m) => m[1]),
    );
    expect(declaring.sort()).toEqual([...Object.keys(SEARCH_VALIDATORS), ...ROUTES_VALIDATING_SEARCH_INLINE].sort());
  });
});
