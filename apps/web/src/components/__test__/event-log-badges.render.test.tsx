import type { EventLogEntry } from '@repo/api-client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DurabilityBadge, OutcomeBadge } from '../event-log-badges';

function entry(overrides: Partial<EventLogEntry>): EventLogEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tier: 'EVIDENCE',
    durability: 'ATOMIC',
    resource: 'device-secret',
    action: 'access',
    actionKey: 'device-secret.revealed',
    actorType: 'UI',
    actorId: 'user-1',
    actorLabel: 'someone@example.com',
    apiKeyId: null,
    apiKeyLabel: null,
    targetId: null,
    targetLabel: null,
    outcome: 'SUCCEEDED',
    errorCode: null,
    requestId: null,
    method: null,
    path: null,
    ipAddress: null,
    userAgent: null,
    metadata: null,
    createdAt: new Date('2026-08-26T00:00:00.000Z'),
    ...overrides,
  };
}

describe('DurabilityBadge', () => {
  it('labels a MIRROR row as mirrored with muted styling', () => {
    render(<DurabilityBadge entry={entry({ durability: 'MIRROR' })} />);

    const badge = screen.getByText('Mirrored');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('text-muted-foreground');
  });

  it('labels an ATOMIC row as evidence', () => {
    render(<DurabilityBadge entry={entry({ durability: 'ATOMIC' })} />);

    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.queryByText('Mirrored')).not.toBeInTheDocument();
  });

  it('distinguishes a best-effort evidence row from an activity row', () => {
    const { unmount } = render(<DurabilityBadge entry={entry({ durability: 'BEST_EFFORT', tier: 'EVIDENCE' })} />);
    expect(screen.getByText('Evidence (best effort)')).toBeInTheDocument();
    unmount();

    render(<DurabilityBadge entry={entry({ durability: 'BEST_EFFORT', tier: 'ACTIVITY' })} />);
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('does not label a POST_COMMIT row as mirrored', () => {
    render(<DurabilityBadge entry={entry({ durability: 'POST_COMMIT', tier: 'EVIDENCE' })} />);

    expect(screen.queryByText('Mirrored')).not.toBeInTheDocument();
    expect(screen.getByText('Evidence (best effort)')).toBeInTheDocument();
  });
});

describe('OutcomeBadge', () => {
  it('renders each outcome', () => {
    const { unmount: unmountSucceeded } = render(<OutcomeBadge outcome="SUCCEEDED" />);
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    unmountSucceeded();

    const { unmount: unmountDenied } = render(<OutcomeBadge outcome="DENIED" />);
    expect(screen.getByText('Denied')).toBeInTheDocument();
    unmountDenied();

    render(<OutcomeBadge outcome="FAILED" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
