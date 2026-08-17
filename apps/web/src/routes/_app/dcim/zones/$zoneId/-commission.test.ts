import type { CommissioningProgressItem, SagaStep, ScannedDevice } from '@repo/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScanBody,
  compareSortCell,
  deriveCommissioningStatus,
  deviceKey,
  effectiveSubnetSelection,
  enrichPollOutcome,
  formatMacInput,
  getPhaseStatus,
  identityKey,
  ipv4ToInt,
  normalizeMac,
  phaseFraction,
  summarizeSubnets,
  toggleSubnet,
} from './commission';

function mkStep(overrides: Partial<SagaStep> = {}): SagaStep {
  return {
    name: 'step',
    operation: 'Step',
    status: 'pending',
    phase: 'commission',
    startedAt: null,
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function mkItem(overrides: Partial<CommissioningProgressItem> = {}): CommissioningProgressItem {
  return {
    deviceId: 'dev-1',
    bmcMac: 'AA:BB:CC:DD:EE:FF',
    bmcIp: '10.0.0.5',
    nicMac: null,
    nicIp: null,
    serial: null,
    deviceStatus: 'PLANNED',
    zoneId: 'zone-1',
    zoneOnline: true,
    lifecycleFailed: false,
    lifecycleQualified: false,
    sagaSteps: [],
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
    ...overrides,
  };
}

function mkScanned(overrides: Partial<ScannedDevice> = {}): ScannedDevice {
  return {
    id: null,
    bmcMac: '',
    bmcIp: '',
    nicMac: '',
    nicIp: '',
    hasIpmi: false,
    hasRedfish: false,
    serial: '',
    boardSerial: '',
    chassisSerial: '',
    manufacturer: '',
    enriched: false,
    commissioningStatus: 'Detected',
    ...overrides,
  };
}

describe('normalizeMac', () => {
  it('strips colon/dash/dot separators and lowercases', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff');
    expect(normalizeMac('aa-bb.cc-dd')).toBe('aabbccdd');
  });
  it('returns empty string for null/undefined', () => {
    expect(normalizeMac(null)).toBe('');
    expect(normalizeMac(undefined)).toBe('');
  });
});

describe('formatMacInput', () => {
  it('upper-cases and colon-groups any separator style', () => {
    expect(formatMacInput('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(formatMacInput('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(formatMacInput('aabb.ccdd.eeff')).toBe('AA:BB:CC:DD:EE:FF');
  });
  it('drops non-hex characters', () => {
    expect(formatMacInput('zzaabb')).toBe('AA:BB');
  });
  it('truncates to 6 octets (12 hex digits)', () => {
    expect(formatMacInput('aabbccddeeff0011')).toBe('AA:BB:CC:DD:EE:FF');
  });
  it('handles partial and empty input', () => {
    expect(formatMacInput('a')).toBe('A');
    expect(formatMacInput('')).toBe('');
  });
});

describe('identityKey', () => {
  it('prefers a normalized MAC over IP', () => {
    expect(identityKey('AA:BB:CC:DD:EE:FF', '10.0.0.5')).toBe('mac:aabbccddeeff');
    expect(identityKey('aa-bb-cc-dd-ee-ff', null)).toBe('mac:aabbccddeeff');
  });
  it('falls back to the host portion of the IP (mask stripped, lowercased) when no MAC', () => {
    expect(identityKey(null, '10.0.0.5/24')).toBe('ip:10.0.0.5');
    expect(identityKey('', 'FE80::1')).toBe('ip:fe80::1');
  });
  it('returns empty string when neither is present', () => {
    expect(identityKey(null, null)).toBe('');
    expect(identityKey('', '')).toBe('');
  });
});

describe('deviceKey', () => {
  it('prefers bmcMac, then nicMac, then bmcIp', () => {
    expect(deviceKey(mkScanned({ bmcMac: 'AA', nicMac: 'BB', bmcIp: '1.1.1.1' }))).toBe('AA');
    expect(deviceKey(mkScanned({ bmcMac: '', nicMac: 'BB', bmcIp: '1.1.1.1' }))).toBe('BB');
    expect(deviceKey(mkScanned({ bmcMac: '', nicMac: '', bmcIp: '1.1.1.1' }))).toBe('1.1.1.1');
  });
});

describe('summarizeSubnets', () => {
  it('joins subnets comma-separated up to the shown limit', () => {
    expect(summarizeSubnets([])).toBe('');
    expect(summarizeSubnets(['10.99.1.0/24'])).toBe('10.99.1.0/24');
    expect(summarizeSubnets(['10.99.1.0/24', '10.0.9.0/24'])).toBe('10.99.1.0/24, 10.0.9.0/24');
  });
  it('collapses overflow into a +N suffix', () => {
    expect(summarizeSubnets(['a/24', 'b/24', 'c/24'])).toBe('a/24, b/24 +1');
    expect(summarizeSubnets(['a/24', 'b/24', 'c/24', 'd/24'])).toBe('a/24, b/24 +2');
  });
  it('respects a custom shown limit', () => {
    expect(summarizeSubnets(['a/24', 'b/24', 'c/24'], 1)).toBe('a/24 +2');
  });
});

describe('effectiveSubnetSelection', () => {
  it('selects every available subnet when the selection is null', () => {
    expect(effectiveSubnetSelection(null, ['a/24', 'b/24'])).toEqual(['a/24', 'b/24']);
    expect(effectiveSubnetSelection(null, [])).toEqual([]);
  });
  it('drops selected subnets that are no longer available', () => {
    expect(effectiveSubnetSelection(['a/24', 'stale/24'], ['a/24', 'b/24'])).toEqual(['a/24']);
  });
  it('keeps an explicit empty selection empty', () => {
    expect(effectiveSubnetSelection([], ['a/24'])).toEqual([]);
  });
});

describe('toggleSubnet', () => {
  it('materializes the all-selected default before removing a subnet', () => {
    expect(toggleSubnet(null, ['a/24', 'b/24'], 'a/24')).toEqual(['b/24']);
  });
  it('adds a subnet missing from the selection', () => {
    expect(toggleSubnet(['a/24'], ['a/24', 'b/24'], 'b/24')).toEqual(['a/24', 'b/24']);
  });
  it('removes a subnet already in the selection', () => {
    expect(toggleSubnet(['a/24', 'b/24'], ['a/24', 'b/24'], 'b/24')).toEqual(['a/24']);
  });
});

describe('buildScanBody', () => {
  it('sends an empty scan-all body when every subnet is selected', () => {
    expect(buildScanBody(['a/24', 'b/24'], ['a/24', 'b/24'])).toEqual({});
  });
  it('sends the subnets override for a partial selection', () => {
    expect(buildScanBody(['a/24'], ['a/24', 'b/24'])).toEqual({ subnets: ['a/24'] });
  });
});

describe('deriveCommissioningStatus', () => {
  afterEach(() => vi.useRealTimers());

  it('returns Failed when the durable lifecycleFailed marker is set (even with no failed step)', () => {
    expect(deriveCommissioningStatus(mkItem({ lifecycleFailed: true }))).toBe('Failed');
  });

  it('returns Failed when any saga step failed', () => {
    expect(
      deriveCommissioningStatus(mkItem({ sagaSteps: [mkStep({ status: 'complete' }), mkStep({ status: 'failed' })] })),
    ).toBe('Failed');
  });

  it('durable lifecycleQualified wins over a stale failed saga step (Done, not Failed)', () => {
    const item = mkItem({ lifecycleQualified: true, sagaSteps: [mkStep({ status: 'failed', phase: 'provision' })] });
    expect(deriveCommissioningStatus(item)).toBe('Done');
  });

  it('durable lifecycleFailed still wins over everything', () => {
    const item = mkItem({
      lifecycleFailed: true,
      sagaSteps: [mkStep({ phase: 'deprovision', status: 'complete' })],
    });
    expect(deriveCommissioningStatus(item)).toBe('Failed');
  });

  it('returns Done from the durable lifecycleQualified marker even when saga steps have aged out', () => {
    expect(deriveCommissioningStatus(mkItem({ lifecycleQualified: true, zoneOnline: false, sagaSteps: [] }))).toBe(
      'Done',
    );
  });

  it('returns Done only when every terminal (deprovision) step is complete', () => {
    const item = mkItem({
      sagaSteps: [
        mkStep({ phase: 'provision', status: 'complete' }),
        mkStep({ phase: 'deprovision', status: 'complete' }),
        mkStep({ phase: 'deprovision', status: 'complete' }),
      ],
    });
    expect(deriveCommissioningStatus(item)).toBe('Done');
  });

  it('is not Done while a terminal step is still running', () => {
    const item = mkItem({
      zoneOnline: true,
      sagaSteps: [
        mkStep({ phase: 'deprovision', status: 'complete', completedAt: new Date().toISOString() }),
        mkStep({ phase: 'deprovision', status: 'running' }),
      ],
    });
    expect(deriveCommissioningStatus(item)).not.toBe('Done');
  });

  it('returns Stalled when the zone bridge is offline', () => {
    expect(deriveCommissioningStatus(mkItem({ zoneOnline: false }))).toBe('Stalled');
  });

  it('returns Stalled when there has been no saga activity within the inactivity window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-26T01:00:00.000Z'));
    const item = mkItem({ zoneOnline: true, updatedAt: '2026-06-26T00:20:00.000Z', sagaSteps: [] });
    expect(deriveCommissioningStatus(item)).toBe('Stalled');
  });

  it('returns InProgress when the zone is online and there is recent saga activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-26T01:00:00.000Z'));
    const item = mkItem({
      zoneOnline: true,
      updatedAt: '2026-06-26T00:00:00.000Z',
      sagaSteps: [mkStep({ phase: 'provision', status: 'running', completedAt: '2026-06-26T00:59:00.000Z' })],
    });
    expect(deriveCommissioningStatus(item)).toBe('InProgress');
  });
});

describe('ipv4ToInt', () => {
  it('converts a clean dotted-quad to its integer value', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('10.0.0.5')).toBe(167772165);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
  });
  it('rejects anything that is not exactly four parts', () => {
    expect(ipv4ToInt('1.2.3')).toBeNull();
    expect(ipv4ToInt('1.2.3.4.5')).toBeNull();
  });
  it('rejects out-of-range or non-numeric octets and empty parts', () => {
    expect(ipv4ToInt('1.2.3.256')).toBeNull();
    expect(ipv4ToInt('1.2.3.-1')).toBeNull();
    expect(ipv4ToInt('1.2.3.x')).toBeNull();
    expect(ipv4ToInt('1.2.3.')).toBeNull();
  });
});

describe('compareSortCell', () => {
  it('always sorts empty values last, regardless of direction', () => {
    expect(compareSortCell('bmcMac', 'asc', '', 'AA')).toBe(1);
    expect(compareSortCell('bmcMac', 'desc', '', 'AA')).toBe(1);
    expect(compareSortCell('bmcMac', 'asc', 'AA', '')).toBe(-1);
    expect(compareSortCell('bmcMac', 'asc', '', '')).toBe(0);
  });
  it('orders bmcIp numerically, not lexically', () => {
    expect(compareSortCell('bmcIp', 'asc', '10.0.0.2', '10.0.0.10')).toBeLessThan(0);
    expect(compareSortCell('bmcIp', 'desc', '10.0.0.2', '10.0.0.10')).toBeGreaterThan(0);
  });
  it('falls back to case-insensitive lexical compare for non-IP columns', () => {
    expect(compareSortCell('manufacturer', 'asc', 'acme', 'Dell')).toBeLessThan(0);
    expect(compareSortCell('manufacturer', 'desc', 'acme', 'Dell')).toBeGreaterThan(0);
  });
});

describe('getPhaseStatus / phaseFraction', () => {
  it('getPhaseStatus prioritizes failed > running > all-complete > pending', () => {
    expect(getPhaseStatus([{ status: 'complete' }, { status: 'failed' }, { status: 'running' }])).toBe('failed');
    expect(getPhaseStatus([{ status: 'complete' }, { status: 'running' }])).toBe('running');
    expect(getPhaseStatus([{ status: 'complete' }, { status: 'complete' }])).toBe('complete');
    expect(getPhaseStatus([{ status: 'pending' }, { status: 'complete' }])).toBe('pending');
    expect(getPhaseStatus([])).toBe('pending');
  });
  it('phaseFraction is the completed share, 0 for an empty phase', () => {
    expect(phaseFraction([])).toBe(0);
    expect(phaseFraction([{ status: 'complete' }, { status: 'complete' }, { status: 'pending' }])).toBeCloseTo(2 / 3);
    expect(phaseFraction([{ status: 'complete' }, { status: 'complete' }])).toBe(1);
  });
});

describe('enrichPollOutcome', () => {
  const TIMEOUT = 20 * 60 * 1000;

  it('keeps a fresh pending plan spinning', () => {
    expect(enrichPollOutcome({ status: 'pending', startedAt: 1000, now: 1000 + 5000, timeoutMs: TIMEOUT })).toEqual({
      kind: 'keep',
    });
  });

  it('times out a pending plan client-side once past the deadline even if the server says pending', () => {
    expect(
      enrichPollOutcome({ status: 'pending', startedAt: 1000, now: 1000 + TIMEOUT + 1, timeoutMs: TIMEOUT }),
    ).toEqual({ kind: 'expired' });
  });

  it('surfaces expired when the server reports the plan gone/cancelled', () => {
    expect(enrichPollOutcome({ status: 'expired', startedAt: 1000, now: 2000, timeoutMs: TIMEOUT })).toEqual({
      kind: 'expired',
    });
  });

  it('clears silently on complete', () => {
    expect(enrichPollOutcome({ status: 'complete', startedAt: 1000, now: 2000, timeoutMs: TIMEOUT })).toEqual({
      kind: 'clear',
    });
  });

  it('surfaces a failure with the server error message', () => {
    expect(
      enrichPollOutcome({ status: 'failed', startedAt: 1000, now: 2000, timeoutMs: TIMEOUT, error: 'IPMI bad' }),
    ).toEqual({ kind: 'failed', message: 'IPMI bad' });
  });

  it('falls back to a generic failure message when the server omits one', () => {
    expect(
      enrichPollOutcome({ status: 'failed', startedAt: 1000, now: 2000, timeoutMs: TIMEOUT, error: null }),
    ).toEqual({ kind: 'failed', message: 'Enrichment failed' });
  });

  it('keeps polling when there is no started timestamp (pre-timeout-feature plan) and status is pending', () => {
    expect(enrichPollOutcome({ status: 'pending', startedAt: undefined, now: 999999999, timeoutMs: TIMEOUT })).toEqual({
      kind: 'keep',
    });
  });

  it('lets a terminal server status win even when it arrives past the client timeout', () => {
    const past = 1000 + TIMEOUT + 1;
    expect(enrichPollOutcome({ status: 'complete', startedAt: 1000, now: past, timeoutMs: TIMEOUT })).toEqual({
      kind: 'clear',
    });
    expect(
      enrichPollOutcome({ status: 'failed', startedAt: 1000, now: past, timeoutMs: TIMEOUT, error: 'late fail' }),
    ).toEqual({ kind: 'failed', message: 'late fail' });
  });
});
