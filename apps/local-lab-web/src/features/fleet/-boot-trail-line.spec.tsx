// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootTrail } from '@/contract';

import { BootTrailLine, bootTrailLine } from './boot-trail-line';

const { lab } = vi.hoisted(() => ({
  lab: { trail: undefined as { status: number; body: BootTrail } | undefined },
}));

vi.mock('@/lib/api', () => ({
  tsr: { getMachineBootTrail: { useQuery: () => ({ data: lab.trail }) } },
}));

const PXE_AT = Date.UTC(2026, 8, 11, 14, 30, 5);
const CHAIN_AT = PXE_AT + 12_000;
const clock = (ms: number) => new Date(ms).toLocaleTimeString();

function trail(overrides: Partial<BootTrail> = {}): BootTrail {
  return { pxe: null, chainReached: false, chainAtMs: null, readError: null, ...overrides };
}

describe('bootTrailLine', () => {
  it('says the boot trail is unreadable when the bridge redis could not be read', () => {
    expect(bootTrailLine(trail({ readError: 'ECONNREFUSED', chainReached: null }))).toBe(
      'boot trail unreadable: ECONNREFUSED',
    );
  });

  it('says no PXE request was seen when the trail holds none', () => {
    expect(bootTrailLine(trail())).toBe('no PXE request seen yet');
  });

  it('says the chain was reached with no request when iPXE came without a bridge decision', () => {
    expect(bootTrailLine(trail({ chainReached: true, chainAtMs: CHAIN_AT }))).toBe(
      `iPXE chain reached at ${clock(CHAIN_AT)}, no PXE request recorded`,
    );
    expect(bootTrailLine(trail({ chainReached: true }))).toBe('iPXE chain reached, no PXE request recorded');
  });

  it('shows the PXE decision time and an unreached chain', () => {
    expect(bootTrailLine(trail({ pxe: { outcome: 'offered', atMs: PXE_AT } }))).toBe(
      `PXE offered at ${clock(PXE_AT)}; iPXE chain not reached yet`,
    );
  });

  it('shows the chain hit time once iPXE reached the chain route', () => {
    expect(
      bootTrailLine(
        trail({ pxe: { outcome: 'refused-allowlist', atMs: PXE_AT }, chainReached: true, chainAtMs: CHAIN_AT }),
      ),
    ).toBe(`PXE refused-allowlist at ${clock(PXE_AT)}; iPXE chain reached at ${clock(CHAIN_AT)}`);
  });

  it('says the chain was reached without a time when only the pending marker proves it', () => {
    expect(bootTrailLine(trail({ pxe: { outcome: 'offered', atMs: PXE_AT }, chainReached: true }))).toBe(
      `PXE offered at ${clock(PXE_AT)}; iPXE chain reached`,
    );
  });
});

describe('BootTrailLine', () => {
  afterEach(() => {
    cleanup();
    lab.trail = undefined;
  });

  it('renders the boot trail line once the query answers', () => {
    lab.trail = { status: 200, body: trail({ pxe: { outcome: 'offered', atMs: PXE_AT } }) };
    render(<BootTrailLine name="metal-1" />);
    expect(screen.getByText(`PXE offered at ${clock(PXE_AT)}; iPXE chain not reached yet`)).toBeTruthy();
  });

  it('renders nothing while the query has not answered', () => {
    const { container } = render(<BootTrailLine name="metal-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the query answers with an error status', () => {
    lab.trail = { status: 404, body: trail() };
    const { container } = render(<BootTrailLine name="metal-1" />);
    expect(container.firstChild).toBeNull();
  });
});
