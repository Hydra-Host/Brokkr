import { activeTab, tabHref, visibleTabs } from '@repo/domain-ui/hooks/server-tabs';
import { describe, expect, it } from 'vitest';

import { GATE_PASSES, SERVER_TABS } from './-server-tabs';

const BASE = '/dcim/servers/dev-1';

describe('SERVER_TABS gating', () => {
  it('hides Jobs without either job gate', () => {
    const names = visibleTabs(SERVER_TABS, { canAccessJobLogs: false, canViewJobs: false }, GATE_PASSES).map(
      (t) => t.name,
    );
    expect(names).not.toContain('Jobs');
    expect(names).toContain('Overview');
  });

  it('shows Jobs with job-log access alone', () => {
    const names = visibleTabs(SERVER_TABS, { canAccessJobLogs: true, canViewJobs: false }, GATE_PASSES).map(
      (t) => t.name,
    );
    expect(names).toContain('Jobs');
  });

  it('shows Jobs with the operator job gate alone', () => {
    const names = visibleTabs(SERVER_TABS, { canAccessJobLogs: false, canViewJobs: true }, GATE_PASSES).map(
      (t) => t.name,
    );
    expect(names).toContain('Jobs');
  });

  it('keeps the catalog order', () => {
    const names = visibleTabs(SERVER_TABS, { canAccessJobLogs: true, canViewJobs: true }, GATE_PASSES).map(
      (t) => t.name,
    );
    expect(names).toHaveLength(10);
    expect(names.slice(0, 3)).toEqual(['Overview', 'Networking', 'BMC Secrets']);
    expect(names.at(-1)).toBe('Settings');
  });
});

describe('SERVER_TABS hrefs', () => {
  it('builds the overview href without a trailing segment', () => {
    expect(tabHref(BASE, SERVER_TABS[0]!)).toBe('/dcim/servers/dev-1');
    expect(tabHref(BASE, SERVER_TABS[1]!)).toBe('/dcim/servers/dev-1/networking');
  });

  it('resolves the active tab from the pathname', () => {
    expect(activeTab('/dcim/servers/dev-1/networking', BASE, SERVER_TABS)?.name).toBe('Networking');
    expect(activeTab('/dcim/servers/dev-1/diagnostics', BASE, SERVER_TABS)?.name).toBe('Diagnostics');
    expect(activeTab('/dcim/servers/dev-1/', BASE, SERVER_TABS)?.name).toBe('Overview');
  });

  it('returns undefined for a path outside the catalog', () => {
    expect(activeTab('/dcim/servers/dev-1/unknown', BASE, SERVER_TABS)).toBeUndefined();
    expect(activeTab('/dcim/servers/dev-1/boot', BASE, SERVER_TABS)).toBeUndefined();
  });
});
