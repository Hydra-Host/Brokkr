// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZoneRuntime } from '@/contract';

const { query } = vi.hoisted(() => ({
  query: { zones: null as ZoneRuntime[] | null, error: null as string | null, isPending: false },
}));

vi.mock('./use-zone-runtime', () => ({ useZoneRuntime: () => query }));

import { ZoneRuntimeTiles } from './zone-runtime-tiles';

const NOW = 1_700_000_000_000;

const zone = (over: Partial<ZoneRuntime> = {}): ZoneRuntime => ({
  zoneId: 'zone-a',
  zoneName: 'sim-zone',
  leader: { holder: 'spoke', ttlSeconds: 28, readError: null },
  bridges: { rows: [], readError: null },
  vrrp: { observability: 'shim', vips: [], readError: null },
  zoneCrypto: { state: 'enrolled', bootstrapLockTtlSeconds: null, readError: null },
  agentWork: { dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null },
  readError: null,
  ...over,
});

const renderTiles = (zones: ZoneRuntime[] | null, error: string | null = null) => {
  query.zones = zones;
  query.error = error;
  return render(<ZoneRuntimeTiles nowMs={NOW} />);
};

beforeEach(() => {
  query.zones = null;
  query.error = null;
});

afterEach(cleanup);

describe('ZoneRuntimeTiles', () => {
  it('rolls up the zones that hold a lease', () => {
    renderTiles([zone(), zone({ zoneId: 'zone-b', leader: { holder: null, ttlSeconds: null, readError: null } })]);

    expect(screen.getByText('1/2')).toBeDefined();
  });

  it('excludes an undetermined zone from the denominator and says so', () => {
    renderTiles([zone(), zone({ zoneId: 'zone-b', readError: 'redis gone' })]);

    expect(screen.getByText('1/1')).toBeDefined();
    expect(screen.getByText('excludes 1 undetermined')).toBeDefined();
    expect(screen.queryByText('1/2')).toBeNull();
  });

  it('does not claim every zone holds a lease when none does', () => {
    renderTiles([
      zone({ leader: { holder: null, ttlSeconds: null, readError: null } }),
      zone({ zoneId: 'zone-b', leader: { holder: null, ttlSeconds: null, readError: null } }),
    ]);

    expect(screen.getByText('0/2')).toBeDefined();
    expect(screen.queryByText('every zone holds a lease')).toBeNull();
    expect(screen.getByText('2 unheld')).toBeDefined();
  });

  it('does not report zone crypto as enrolled when every zone is undetermined', () => {
    renderTiles([zone({ zoneCrypto: { state: 'unknown', bootstrapLockTtlSeconds: null, readError: 'boom' } })]);

    expect(screen.queryByText('enrolled')).toBeNull();
    expect(screen.getByText('undetermined')).toBeDefined();
  });

  it('separates unobserved vips from ones whose atom did not parse', () => {
    renderTiles([
      zone({
        vrrp: {
          observability: 'shim',
          vips: [
            {
              prefixId: 'p1',
              vip: '10.0.1.1/24',
              ifaceByBridge: {},
              garpCount: null,
              writtenAtMs: NOW,
              requestId: null,
              desiredHolder: null,
              observedHolders: null,
              atomError: null,
            },
            {
              prefixId: 'p2',
              vip: null,
              ifaceByBridge: {},
              garpCount: null,
              writtenAtMs: null,
              requestId: null,
              desiredHolder: null,
              observedHolders: null,
              atomError: 'bad envelope',
            },
          ],
          readError: null,
        },
      }),
    ]);

    expect(screen.getByText(/1 unobserved/)).toBeDefined();
    expect(screen.getByText(/1 unreadable/)).toBeDefined();
  });

  it('renders nothing at all rather than a zeroed rollup when the read failed', () => {
    const { container } = renderTiles(null, 'ECONNREFUSED');

    expect(container.innerHTML).toBe('');
    expect(screen.queryAllByText('0')).toHaveLength(0);
  });

  it('renders nothing while the first read is still in flight', () => {
    const { container } = renderTiles(null);

    expect(container.innerHTML).toBe('');
  });

  it('surfaces a diverging vip ahead of the agreeing count', () => {
    renderTiles([
      zone({
        vrrp: {
          observability: 'shim',
          vips: [
            {
              prefixId: 'p1',
              vip: '10.0.1.1/24',
              ifaceByBridge: { spoke: 'eth0' },
              garpCount: null,
              writtenAtMs: NOW,
              requestId: null,
              desiredHolder: 'spoke',
              observedHolders: ['spoke-2'],
              atomError: null,
            },
          ],
          readError: null,
        },
      }),
    ]);

    expect(screen.getByText('1 diverging')).toBeDefined();
  });

  it('reports no agent activity as none seen rather than as a timestamp', () => {
    renderTiles([zone()]);

    expect(screen.getByText('none seen')).toBeDefined();
  });

  it('reports the newest agent activity as an age', () => {
    renderTiles([
      zone({ agentWork: { dispatchesInFlight: 1, lastActivityAtMs: NOW - 4000, scanCapped: false, readError: null } }),
    ]);

    expect(screen.getByText('4s ago')).toBeDefined();
  });

  it('does not report zone crypto as enrolled while a zone is still bootstrapping', () => {
    renderTiles([zone({ zoneCrypto: { state: 'bootstrapping', bootstrapLockTtlSeconds: 300, readError: null } })]);

    expect(screen.queryByText('enrolled')).toBeNull();
    expect(screen.getByText('1 bootstrapping')).toBeDefined();
  });

  it('does not report vips as intended for a zone whose vrrp section could not be read', () => {
    renderTiles([zone({ vrrp: { observability: 'unavailable', vips: [], readError: 'ECONNREFUSED' } })]);

    expect(screen.queryByText('0 as intended')).toBeNull();
    expect(screen.getByText(/1 zone\(s\) unread/)).toBeDefined();
  });

  it('lays the row out two-up, since it renders inside the 320px rail', () => {
    const { container } = renderTiles([zone()]);
    const row = container.firstElementChild;

    expect(row?.className).toContain('grid-cols-2');
    expect(row?.className).not.toContain('grid-cols-4');
  });

  it('renders no source comment as visible text', () => {
    const { container } = renderTiles([zone()]);

    expect(container.textContent).not.toContain('two-up');
    expect(container.textContent).not.toContain('//');
  });

  it('lets every tile shrink inside its track rather than widening the row', () => {
    const { container } = renderTiles([
      zone({ zoneCrypto: { state: 'not-enrolled', bootstrapLockTtlSeconds: null, readError: null } }),
    ]);
    const tiles = [...(container.firstElementChild?.children ?? [])];

    expect(tiles).toHaveLength(4);
    for (const tile of tiles) expect(tile.className).toContain('min-w-0');
  });
});
