import { describe, expect, it } from 'vitest';
import { activeOrganizationTab, visibleOrganizationTabs } from '../organization-tabs';

const denyAll = () => false;
const allowAll = () => true;
const allow = (...keys: string[]) => (resource: string, action: string) => keys.includes(`${resource}:${action}`);

describe('visibleOrganizationTabs', () => {
  it('hides the event log from a member without access', () => {
    expect(visibleOrganizationTabs(denyAll).map((tab) => tab.name)).not.toContain('Event Log');
  });

  it('shows the event log to an admin holding event-log:access', () => {
    expect(visibleOrganizationTabs(allow('event-log:access')).map((tab) => tab.name)).toContain('Event Log');
  });

  it('leaves ungated tabs visible to a member with no permissions at all', () => {
    expect(visibleOrganizationTabs(denyAll).map((tab) => tab.name)).toEqual([
      'Members',
      'Roles',
      'API Keys',
      'Webhooks',
      'Settings',
    ]);
  });

  it('keeps the event log in its position rather than appending it', () => {
    expect(visibleOrganizationTabs(allowAll).map((tab) => tab.name)).toEqual([
      'Members',
      'Roles',
      'API Keys',
      'Webhooks',
      'Event Log',
      'Settings',
    ]);
  });
});

describe('activeOrganizationTab', () => {
  it('matches the event log exactly', () => {
    const tabs = visibleOrganizationTabs(allowAll);

    expect(activeOrganizationTab('/organizations/event-log', tabs)?.name).toBe('Event Log');
  });

  it('matches a nested path under a tab', () => {
    const tabs = visibleOrganizationTabs(allowAll);

    expect(activeOrganizationTab('/organizations/api-keys/create', tabs)?.name).toBe('API Keys');
  });

  it('returns nothing for a tab the caller cannot see', () => {
    const tabs = visibleOrganizationTabs(denyAll);

    expect(activeOrganizationTab('/organizations/event-log', tabs)).toBeUndefined();
  });
});
