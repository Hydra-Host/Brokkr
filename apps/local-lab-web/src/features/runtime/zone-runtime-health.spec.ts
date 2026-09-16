import { describe, expect, it } from 'vitest';

import type { ZoneRuntime, ZoneVip } from '@/contract';

import { leaderDisagrees, summarizeZoneRuntime, undeterminedNote, vipAgreement } from './zone-runtime-health';

const vip = (over: Partial<ZoneVip> = {}): ZoneVip => ({
  prefixId: 'prefix-1',
  vip: '10.0.1.1/24',
  ifaceByBridge: { spoke: 'eth0' },
  garpCount: null,
  writtenAtMs: 1_700_000_000_000,
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
  bridges: { rows: [], readError: null },
  vrrp: { observability: 'shim', vips: [], readError: null },
  zoneCrypto: { state: 'enrolled', bootstrapLockTtlSeconds: null, readError: null },
  agentWork: { dispatchesInFlight: 0, lastActivityAtMs: null, scanCapped: false, readError: null },
  readError: null,
  ...over,
});

const bridge = (instanceId: string, isLeader: boolean | null) => ({
  instanceId,
  expected: true,
  registered: true,
  isLeader,
  online: true,
  registeredAtMs: 1_700_000_000_000,
  workerVersion: null,
  liveVersion: null,
  interfaces: null,
  plugins: null,
  port: null,
  grpcPort: null,
  http: null,
  readError: null,
});

describe('vipAgreement', () => {
  it('agrees when the observed holder is the desired one', () => {
    expect(vipAgreement(vip())).toBe('agrees');
  });

  it('diverges when somebody else holds it', () => {
    expect(vipAgreement(vip({ observedHolders: ['spoke-2'] }))).toBe('diverges');
  });

  it('diverges when two bridges hold it at once', () => {
    expect(vipAgreement(vip({ observedHolders: ['spoke', 'spoke-2'] }))).toBe('diverges');
  });

  it('diverges when nobody holds a vip that should be held', () => {
    expect(vipAgreement(vip({ observedHolders: [] }))).toBe('diverges');
  });

  it('agrees when nobody should hold it and nobody does', () => {
    expect(vipAgreement(vip({ desiredHolder: null, observedHolders: [] }))).toBe('agrees');
  });

  it('reports unobserved rather than divergence when nothing could be observed', () => {
    expect(vipAgreement(vip({ observedHolders: null }))).toBe('unobserved');
  });

  it('reports unknown for an atom that did not parse', () => {
    expect(vipAgreement(vip({ atomError: 'bad envelope' }))).toBe('unknown');
  });
});

describe('leaderDisagrees', () => {
  it('flags a bridge still claiming leadership the lease gives to another', () => {
    expect(leaderDisagrees(zone({ bridges: { rows: [bridge('spoke-2', true)], readError: null } }))).toBe(true);
  });

  it('does not flag agreement', () => {
    expect(leaderDisagrees(zone({ bridges: { rows: [bridge('spoke', true)], readError: null } }))).toBe(false);
  });

  it('does not flag when the bridge flag is undetermined', () => {
    expect(leaderDisagrees(zone({ bridges: { rows: [bridge('spoke-2', null)], readError: null } }))).toBe(false);
  });

  it('does not claim disagreement when the lease itself could not be read', () => {
    const unreadable = zone({
      leader: { holder: null, ttlSeconds: null, readError: 'ECONNREFUSED' },
      bridges: { rows: [bridge('spoke-2', true)], readError: null },
    });
    expect(leaderDisagrees(unreadable)).toBe(false);
  });
});

describe('summarizeZoneRuntime', () => {
  it('counts a zone with a leader', () => {
    const totals = summarizeZoneRuntime([zone()]);

    expect(totals).toMatchObject({ zones: 1, zonesWithLeader: 1, leaderUndetermined: 0 });
  });

  it('excludes an undetermined leader from the leader tally rather than counting it as none', () => {
    const totals = summarizeZoneRuntime([zone({ leader: { holder: null, ttlSeconds: null, readError: 'boom' } })]);

    expect(totals.zonesWithLeader).toBe(0);
    expect(totals.leaderUndetermined).toBe(1);
  });

  it('separates agreeing, diverging and unobserved vips', () => {
    const totals = summarizeZoneRuntime([
      zone({
        vrrp: {
          observability: 'shim',
          vips: [
            vip(),
            vip({ prefixId: 'p2', observedHolders: ['spoke-2'] }),
            vip({ prefixId: 'p3', observedHolders: null }),
          ],
          readError: null,
        },
      }),
    ]);

    expect(totals).toMatchObject({ vipsAgreeing: 1, vipsDiverging: 1, vipsUnobserved: 1 });
  });

  it('excludes an unknown crypto state from the not-enrolled tally', () => {
    const totals = summarizeZoneRuntime([
      zone({ zoneCrypto: { state: 'unknown', bootstrapLockTtlSeconds: null, readError: 'boom' } }),
    ]);

    expect(totals.zonesNotEnrolled).toBe(0);
    expect(totals.cryptoUndetermined).toBe(1);
  });

  it('takes the newest agent activity across zones', () => {
    const totals = summarizeZoneRuntime([
      zone({ agentWork: { dispatchesInFlight: 1, lastActivityAtMs: 10, scanCapped: false, readError: null } }),
      zone({ agentWork: { dispatchesInFlight: 1, lastActivityAtMs: 90, scanCapped: false, readError: null } }),
    ]);

    expect(totals.lastAgentActivityAtMs).toBe(90);
  });

  it('reports the undetermined note only when something was excluded', () => {
    expect(undeterminedNote(summarizeZoneRuntime([zone()]).leaderUndetermined)).toBeNull();
    expect(undeterminedNote(summarizeZoneRuntime([zone({ readError: 'boom' })]).leaderUndetermined)).toBe(
      'excludes 1 undetermined',
    );
  });

  it('counts one dead zone once per counter rather than three times over', () => {
    const totals = summarizeZoneRuntime([zone({ readError: 'boom' })]);

    expect(totals.leaderUndetermined).toBe(1);
    expect(undeterminedNote(totals.leaderUndetermined)).toBe('excludes 1 undetermined');
  });

  it('keeps a vip whose atom did not parse out of the unobserved tally', () => {
    const totals = summarizeZoneRuntime([
      zone({ vrrp: { observability: 'shim', vips: [vip({ atomError: 'bad envelope' })], readError: null } }),
    ]);

    expect(totals.vipsUnobserved).toBe(0);
    expect(totals.vipsUnreadable).toBe(1);
  });
});

describe('summarizeZoneRuntime unmeasured sections', () => {
  it('counts a zone whose vrrp section failed, which reports no vips to count', () => {
    const totals = summarizeZoneRuntime([
      zone({ vrrp: { observability: 'unavailable', vips: [], readError: 'ECONNREFUSED' } }),
    ]);

    expect(totals.vipsAgreeing).toBe(0);
    expect(totals.vrrpUndetermined).toBe(1);
  });

  it('does not count a healthy zone as vrrp-undetermined', () => {
    expect(summarizeZoneRuntime([zone()]).vrrpUndetermined).toBe(0);
  });

  it('counts a bootstrapping zone separately from enrolled and not-enrolled', () => {
    const totals = summarizeZoneRuntime([
      zone({ zoneCrypto: { state: 'bootstrapping', bootstrapLockTtlSeconds: 300, readError: null } }),
    ]);

    expect(totals.zonesBootstrapping).toBe(1);
    expect(totals.zonesNotEnrolled).toBe(0);
    expect(totals.cryptoUndetermined).toBe(0);
  });
});
