// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FleetPending } from '@/contract';
import { PendingBanner } from './pending-banner';

afterEach(cleanup);

const pending = (over: Partial<FleetPending> = {}): FleetPending =>
  ({
    inSync: false,
    severity: 'hot-appliable',
    desiredDigest: 'a',
    appliedDigest: 'b',
    appliedAt: null,
    summary: { added: 1, removed: 0, changed: 0, unchanged: 2 },
    nodes: { added: [], removed: [], changed: [] },
    network: { changed: false },
    note: null,
    ...over,
  }) as FleetPending;

describe('PendingBanner without an apply handler', () => {
  it('reports the drift as detail and offers no button of its own', () => {
    render(<PendingBanner pending={pending()} busy={false} />);

    expect(screen.getByText(/1 pending change/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers no mode-change button either, so a shared control cannot be duplicated', () => {
    render(<PendingBanner pending={pending({ severity: 'mode-change' })} busy={false} />);

    expect(screen.getByText(/Fleet mode changed/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('still offers the button where a page passes one', () => {
    render(<PendingBanner pending={pending()} busy={false} onApply={() => {}} />);

    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });
});
