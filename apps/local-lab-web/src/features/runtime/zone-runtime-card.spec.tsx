// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ZoneBridge, ZoneRuntime, ZoneVip } from '@/contract';

import { ZoneRuntimeCard } from './zone-runtime-card';

const NOW = 1_700_000_000_000;

const bridge = (over: Partial<ZoneBridge> = {}): ZoneBridge => ({
  instanceId: 'spoke',
  expected: true,
  registered: true,
  isLeader: true,
  online: true,
  registeredAtMs: NOW,
  workerVersion: null,
  liveVersion: null,
  interfaces: null,
  plugins: null,
  port: 8000,
  grpcPort: 9082,
  http: null,
  readError: null,
  ...over,
});

const vip = (over: Partial<ZoneVip> = {}): ZoneVip => ({
  prefixId: 'prefix-1',
  vip: '10.0.1.1/24',
  ifaceByBridge: { spoke: 'eth0' },
  garpCount: null,
  writtenAtMs: NOW,
  requestId: null,
  desiredHolder: 'spoke',
  observedHolders: ['spoke'],
  atomError: null,
  ...over,
});

const zone = (over: Partial<ZoneRuntime> = {}): ZoneRuntime => ({
  zoneId: 'zone-a',
  zoneName: 'sim-zone',
  leader: { holder: 'spoke', ttlSeconds: 28, readError: null },
  bridges: { rows: [bridge()], readError: null },
  vrrp: { observability: 'shim', vips: [vip()], readError: null },
  zoneCrypto: { state: 'enrolled', bootstrapLockTtlSeconds: null, readError: null },
  agentWork: { dispatchesInFlight: 2, lastActivityAtMs: NOW - 4000, scanCapped: false, readError: null },
  readError: null,
  ...over,
});

const renderZone = (over: Partial<ZoneRuntime> = {}) => render(<ZoneRuntimeCard zone={zone(over)} nowMs={NOW} />);

afterEach(cleanup);

describe('ZoneRuntimeCard', () => {
  it('names the zone, its leader and the lease countdown', () => {
    renderZone();

    expect(screen.getByText('sim-zone')).toBeDefined();
    expect(screen.getAllByText(/spoke/).length).toBeGreaterThan(0);
    expect(screen.getByText(/28s left/)).toBeDefined();
  });

  it('reports an unheld lease as unheld rather than as unreadable', () => {
    renderZone({ leader: { holder: null, ttlSeconds: null, readError: null } });

    expect(screen.getByText('unheld')).toBeDefined();
    expect(screen.queryByText(/unreadable/)).toBeNull();
  });

  it('reports an unreadable lease as unreadable rather than as unheld', () => {
    renderZone({ leader: { holder: null, ttlSeconds: null, readError: 'ECONNREFUSED' } });

    expect(screen.getByText(/unreadable/)).toBeDefined();
    expect(screen.queryByText('unheld')).toBeNull();
  });

  it('flags a contested lease when a bridge still claims leadership', () => {
    renderZone({
      leader: { holder: 'spoke', ttlSeconds: 5, readError: null },
      bridges: { rows: [bridge(), bridge({ instanceId: 'spoke-2', isLeader: true })], readError: null },
    });

    expect(screen.getByText('contested')).toBeDefined();
  });

  it('renders no holder list at all when bind state is not observable', () => {
    renderZone({ vrrp: { observability: 'unavailable', vips: [vip({ observedHolders: null })], readError: null } });

    expect(screen.queryByText(/have /)).toBeNull();
    expect(screen.getByTitle(/not observable/)).toBeDefined();
  });

  it('renders an observed empty holder set as a measurement that nobody holds it', () => {
    renderZone({ vrrp: { observability: 'shim', vips: [vip({ observedHolders: [] })], readError: null } });

    expect(screen.getByText(/have nobody/)).toBeDefined();
  });

  it('keeps a malformed vip atom visible with its error', () => {
    renderZone({
      vrrp: { observability: 'shim', vips: [vip({ atomError: 'atom envelope did not parse' })], readError: null },
    });

    expect(screen.getByText('prefix-1')).toBeDefined();
    expect(screen.getByText(/atom envelope did not parse/)).toBeDefined();
  });

  it('distinguishes a zone with no bridges from one whose bridges could not be read', () => {
    const { unmount } = renderZone({ bridges: { rows: [], readError: null } });
    expect(screen.getByText('none')).toBeDefined();
    unmount();

    renderZone({ bridges: { rows: [], readError: 'ECONNREFUSED' } });
    expect(screen.queryByText('none')).toBeNull();
    expect(screen.getByText(/ECONNREFUSED/)).toBeDefined();
  });

  it('marks a configured bridge that never registered', () => {
    renderZone({ bridges: { rows: [bridge({ registered: false, isLeader: null, online: null })], readError: null } });

    expect(screen.getByText('unregistered')).toBeDefined();
  });

  it('keeps an undeclared bridge visible rather than hiding it', () => {
    renderZone({ bridges: { rows: [bridge({ expected: false })], readError: null } });

    expect(screen.getByText('undeclared')).toBeDefined();
  });

  it('renders an undetermined dispatch count as an explicit unknown, never as zero', () => {
    renderZone({
      agentWork: { dispatchesInFlight: null, lastActivityAtMs: null, scanCapped: false, readError: null },
    });

    expect(screen.queryAllByText('0')).toHaveLength(0);
    expect(screen.getByTitle(/not the same as no agent work/)).toBeDefined();
  });

  it('renders a measured zero when the zone genuinely dispatched nothing', () => {
    renderZone({ agentWork: { dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null } });

    expect(screen.getByText(/0 dispatched/)).toBeDefined();
  });

  it('separates never-seen agent work from an unreadable scan', () => {
    const { unmount } = renderZone({
      agentWork: { dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null },
    });
    expect(screen.getByText(/no work seen/)).toBeDefined();
    unmount();

    renderZone({
      agentWork: { dispatchesInFlight: null, lastActivityAtMs: null, scanCapped: false, readError: 'boom' },
    });
    expect(screen.queryByText(/no work seen/)).toBeNull();
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it('warns that a capped scan is a floor rather than a count', () => {
    renderZone({ agentWork: { dispatchesInFlight: 9, lastActivityAtMs: null, scanCapped: true, readError: null } });

    expect(screen.getByText('capped')).toBeDefined();
  });

  it('renders only the whole-zone error when the zone itself could not be assembled', () => {
    renderZone({ readError: 'redis gone' });

    expect(screen.getByText(/redis gone/)).toBeDefined();
    expect(screen.queryByText('leader')).toBeNull();
  });
});
