import type { DeviceHealthSnapshot } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { type HealthCheckRow, presentHealthSummary, snapshotChecks, toHealthCheckRow } from '../health-presenter';

const snapshot: DeviceHealthSnapshot = {
  device_id: '22222222-2222-2222-2222-222222222222',
  primary_reachable: true,
  bmc_icmp_reachable: false,
  bmc_ipmi_reachable: true,
  bmc_redfish_reachable: true,
  bmc_creds_valid: true,
  powered_on: true,
  brokkr_live_running: null,
  checked_at: Date.parse('2026-09-16T11:56:00.000Z') / 1000,
};

const row: HealthCheckRow = {
  id: 'hc-1',
  testedAt: new Date('2026-09-16T11:21:00.000Z'),
  primaryReachable: true,
  bmcIcmpReachable: true,
  bmcIpmiReachable: true,
  bmcRedfishReachable: true,
  bmcCredsValid: false,
  poweredOn: true,
  brokkrLiveRunning: null,
};

describe('snapshotChecks', () => {
  it('renames the bridge snapshot fields to the hub check names', () => {
    expect(snapshotChecks(snapshot)).toEqual({
      primaryReachable: true,
      bmcIcmpReachable: false,
      bmcIpmiReachable: true,
      bmcRedfishReachable: true,
      bmcCredsValid: true,
      poweredOn: true,
      brokkrLiveRunning: null,
    });
  });
});

describe('presentHealthSummary', () => {
  it('derives the owner verdict, reachability and the icmp advisory', () => {
    const out = presentHealthSummary(
      { source: 'snapshot', checkedAt: '2026-09-16T11:56:00.000Z', checks: snapshotChecks(snapshot), ecoMode: false },
      'owner',
    );
    expect(out).toMatchObject({
      view: 'owner',
      source: 'snapshot',
      checkedAt: '2026-09-16T11:56:00.000Z',
      isHealthy: true,
      reason: null,
      icmpFiltered: true,
    });
    expect(out.checks?.reachability).toBe('ok');
  });

  it('names the failing probe for the owner', () => {
    const out = presentHealthSummary(
      { source: 'history', checkedAt: '2026-09-16T11:21:00.000Z', checks: row, ecoMode: false },
      'owner',
    );
    expect(out).toMatchObject({ isHealthy: false, reason: 'BMC credentials are invalid' });
    expect(out.checks?.reachability).toBe('auth-failed');
  });

  it('skips the power probe for an eco-mode device', () => {
    const out = presentHealthSummary(
      { source: 'snapshot', checkedAt: '2026-09-16T11:56:00.000Z', checks: { ...row, bmcCredsValid: true, poweredOn: false }, ecoMode: true },
      'owner',
    );
    expect(out.isHealthy).toBe(true);
  });

  it('nulls every bmc field and the verdict for the customer', () => {
    const out = presentHealthSummary(
      { source: 'snapshot', checkedAt: '2026-09-16T11:56:00.000Z', checks: row, ecoMode: false },
      'customer',
    );
    expect(out).toEqual({
      view: 'customer',
      source: 'snapshot',
      checkedAt: '2026-09-16T11:56:00.000Z',
      checks: {
        primaryReachable: true,
        poweredOn: true,
        bmcIcmpReachable: null,
        bmcIpmiReachable: null,
        bmcRedfishReachable: null,
        bmcCredsValid: null,
        brokkrLiveRunning: null,
        reachability: null,
      },
      isHealthy: null,
      reason: null,
      icmpFiltered: false,
    });
  });

  it('reports none with a null verdict when nothing is known', () => {
    expect(presentHealthSummary(null, 'owner')).toEqual({
      view: 'owner',
      source: 'none',
      checkedAt: null,
      checks: null,
      isHealthy: null,
      reason: null,
      icmpFiltered: false,
    });
  });
});

describe('toHealthCheckRow', () => {
  it('serializes the timestamp and derives reachability', () => {
    expect(toHealthCheckRow(row)).toEqual({
      id: 'hc-1',
      testedAt: '2026-09-16T11:21:00.000Z',
      primaryReachable: true,
      bmcIcmpReachable: true,
      bmcIpmiReachable: true,
      bmcRedfishReachable: true,
      bmcCredsValid: false,
      poweredOn: true,
      brokkrLiveRunning: null,
      reachability: 'auth-failed',
    });
  });
});
