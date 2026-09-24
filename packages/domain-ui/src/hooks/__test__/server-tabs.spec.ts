import { describe, expect, it } from 'vitest';

import { activeTab, tabHref, visibleTabs, type ServerTab, type TabGatePasses } from '../server-tabs';

type Gate = 'logs' | 'jobs';

interface Gates {
  logs: boolean;
  jobs: boolean;
}

const TABS: readonly ServerTab<Gate>[] = [
  { name: 'Overview', segment: '' },
  { name: 'Interfaces', segment: 'interfaces' },
  { name: 'Job Logs', segment: 'job-logs', gate: 'logs' },
  { name: 'Jobs', segment: 'jobs', gate: 'jobs' },
  { name: 'Decommission', segment: 'decommission' },
];

const PASSES: TabGatePasses<Gate, Gates> = {
  logs: (gates) => gates.logs,
  jobs: (gates) => gates.jobs,
};

const BASE = '/servers/dev-1';

describe('visibleTabs', () => {
  it('hides the gated tabs when their gate fails', () => {
    const names = visibleTabs(TABS, { logs: false, jobs: false }, PASSES).map((t) => t.name);
    expect(names).toEqual(['Overview', 'Interfaces', 'Decommission']);
  });

  it('shows each gated tab on its own gate', () => {
    expect(visibleTabs(TABS, { logs: true, jobs: false }, PASSES).map((t) => t.name)).toContain('Job Logs');
    expect(visibleTabs(TABS, { logs: true, jobs: false }, PASSES).map((t) => t.name)).not.toContain('Jobs');
    expect(visibleTabs(TABS, { logs: false, jobs: true }, PASSES).map((t) => t.name)).toContain('Jobs');
  });

  it('keeps the catalog order', () => {
    const names = visibleTabs(TABS, { logs: true, jobs: true }, PASSES).map((t) => t.name);
    expect(names).toEqual(TABS.map((t) => t.name));
  });
});

describe('tabHref and activeTab', () => {
  it('builds the landing href without a trailing segment', () => {
    expect(tabHref(BASE, TABS[0]!)).toBe('/servers/dev-1');
    expect(tabHref(BASE, TABS[1]!)).toBe('/servers/dev-1/interfaces');
  });

  it('resolves the active tab from the pathname', () => {
    expect(activeTab('/servers/dev-1/interfaces', BASE, TABS)?.name).toBe('Interfaces');
    expect(activeTab('/servers/dev-1/jobs/j-1', BASE, TABS)?.name).toBe('Jobs');
    expect(activeTab('/servers/dev-1/', BASE, TABS)?.name).toBe('Overview');
  });

  it('returns undefined outside the base path or the catalog', () => {
    expect(activeTab('/servers/dev-1/unknown', BASE, TABS)).toBeUndefined();
    expect(activeTab('/deployments/dep-1', BASE, TABS)).toBeUndefined();
  });
});
