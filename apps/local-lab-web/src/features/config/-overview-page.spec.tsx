// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigTreeEntry } from '@/contract';

const { lab } = vi.hoisted(() => ({ lab: { tree: undefined as { status: number; body: unknown } | undefined } }));

vi.mock('@/lib/api', () => ({
  tsr: { getConfigTree: { useQuery: () => ({ data: lab.tree, error: undefined }) } },
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, hash, children }: { to: string; hash?: string; children: React.ReactNode }) => (
    <a href={hash ? `${to}#${hash}` : to}>{children}</a>
  ),
}));
vi.mock('@/components/config/api-token-card', () => ({ ApiTokenCard: () => null }));

import { ConfigOverview } from './overview-page';

const entry = (over: Partial<ConfigTreeEntry> & { path: string }): ConfigTreeEntry => {
  const base: ConfigTreeEntry = {
    label: 'Label',
    group: 'Group',
    description: 'Why this knob exists.',
    value: 'same',
    default: 'same',
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'text',
    choices: [],
    danger: false,
    applyClass: 'reload-hub',
    ...over,
  };
  return { ...base, overridden: over.overridden ?? base.value !== base.default };
};

const tree = (entries: ConfigTreeEntry[], seeded = true) => ({ status: 200, body: { seeded, entries } });

afterEach(cleanup);

describe('ConfigOverview', () => {
  beforeEach(() => {
    lab.tree = undefined;
  });

  it('lists a changed knob with what it was and what it is now', () => {
    lab.tree = tree([
      entry({
        path: 'stackDefaults.hub.LOG_LEVEL',
        label: 'Log level',
        value: 'warn',
        default: 'debug',
        definedIn: ['stack.local.nix'],
      }),
    ]);
    render(<ConfigOverview />);

    expect(screen.getByText('Log level')).toBeTruthy();
    expect(screen.getByText('debug → warn')).toBeTruthy();
  });

  it('links a changed knob to the page that owns it, at its own anchor', () => {
    lab.tree = tree([entry({ path: 'ports.postgres', value: '5442', default: '5432' })]);
    render(<ConfigOverview />);

    expect(screen.getByRole('link', { name: 'open →' }).getAttribute('href')).toBe('/config/stack#cfg-ports-postgres');
  });

  it('leaves a knob at its default off the list', () => {
    lab.tree = tree([entry({ path: 'stackDefaults.hub.LOG_LEVEL' })]);
    render(<ConfigOverview />);

    expect(screen.getByText('nothing overridden — this stack runs the declared defaults')).toBeTruthy();
  });

  it('never prints a secret, even when it is the thing that changed', () => {
    lab.tree = tree([entry({ path: 'identity.pg.password', value: 'hunter2', default: 'password', secret: true })]);
    render(<ConfigOverview />);

    expect(screen.queryByText(/hunter2/)).toBeNull();
    expect(screen.getByText('***')).toBeTruthy();
  });

  it('names the variable holding a pinned knob rather than the overlay', () => {
    lab.tree = tree([
      entry({
        path: 'stackDefaults.hub.LOG_LEVEL',
        value: 'warn',
        default: 'debug',
        pinnedBy: 'BROKKR_LOG',
        definedIn: ['stack.local.nix'],
      }),
    ]);
    render(<ConfigOverview />);

    expect(screen.getAllByText('$BROKKR_LOG').length).toBeGreaterThan(0);
  });

  it('says the seed failed rather than presenting bare defaults as config', () => {
    lab.tree = tree([], false);
    render(<ConfigOverview />);

    expect(screen.getByText(/Saving is blocked/)).toBeTruthy();
  });
});
