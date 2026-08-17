import type { EventLogEntry } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { actionDisplay, actorDisplay } from '../event-log';

const entry = (overrides: Partial<EventLogEntry> = {}): EventLogEntry => ({
  id: 'e-1',
  tier: 'EVIDENCE',
  durability: 'ATOMIC',
  resource: 'member',
  action: 'removed',
  actionKey: 'member.removed',
  actorType: 'UI',
  actorId: 'u-1',
  actorLabel: 'admin@example.com',
  apiKeyId: null,
  apiKeyLabel: null,
  targetId: 'm-1',
  targetLabel: 'someone@example.com',
  outcome: 'SUCCEEDED',
  errorCode: null,
  requestId: 'req-1',
  method: 'DELETE',
  path: '/api/v1/members/m-1',
  ipAddress: '10.0.0.1',
  userAgent: 'Mozilla/5.0',
  metadata: null,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  ...overrides,
});

describe('actorDisplay', () => {
  it('leads with the api key name so a bot is not shown as its creator', () => {
    const display = actorDisplay(entry({ actorType: 'API', apiKeyId: 'k-1', apiKeyLabel: 'ci-deploy' }));

    expect(display.primary).toBe('ci-deploy');
  });

  it('keeps the owning human as secondary attribution for an api key', () => {
    const display = actorDisplay(entry({ actorType: 'API', apiKeyId: 'k-1', apiKeyLabel: 'ci-deploy' }));

    expect(display.secondary).toBe('admin@example.com');
  });

  it('never shows the owning human as primary for an unnamed api key', () => {
    const display = actorDisplay(entry({ actorType: 'API', apiKeyId: 'k-2', apiKeyLabel: null }));

    expect(display.primary).not.toBe('admin@example.com');
    expect(display.secondary).toBe('admin@example.com');
  });

  it('leads with the human for a browser session and offers no secondary line', () => {
    const display = actorDisplay(entry());

    expect(display).toEqual({ primary: 'admin@example.com', secondary: null });
  });

  it('names the system actor rather than rendering a blank cell', () => {
    const display = actorDisplay(entry({ actorType: 'SYSTEM', actorId: null, actorLabel: null }));

    expect(display.primary).toBe('System');
  });

  it('marks a labelless non-system actor as unattributed', () => {
    const display = actorDisplay(entry({ actorType: 'DEVICE', actorId: null, actorLabel: null }));

    expect(display.primary).toBe('Unattributed');
  });
});

describe('actionDisplay', () => {
  it('splits the action key into a readable verb and resource', () => {
    expect(actionDisplay(entry())).toEqual({ verb: 'Removed', resource: 'Member' });
  });

  it('humanises hyphenated actions and resources', () => {
    const display = actionDisplay(entry({ resource: 'api-key', action: 'role-changed' }));

    expect(display).toEqual({ verb: 'Role changed', resource: 'Api key' });
  });
});
