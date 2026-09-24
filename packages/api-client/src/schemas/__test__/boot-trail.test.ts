import { describe, expect, it } from 'vitest';
import { DeviceBootReadinessSchema } from '../boot-readiness';
import { DeviceBootTrailSchema, PxeDecisionHashSchema } from '../boot-trail';
import { DeviceTokenSummarySchema } from '../device-tokens';
import { DeviceHealthCheckSchema, DeviceHealthSummarySchema } from '../health-checks';
import { LifecycleJobEventsResponseSchema } from '../jobs';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const NOW = '2026-09-16T12:00:00.000Z';

const trail = {
  pxe: { outcome: 'offered', atMs: 1_789_500_000_000 },
  chainReached: true,
  chainAtMs: 1_789_500_008_000,
  chainDeviceMismatch: false,
  readError: null,
};

describe('boot trail schemas', () => {
  it('parses a device boot trail', () => {
    const parsed = DeviceBootTrailSchema.parse({
      deviceId: DEVICE,
      pxeMac: '3c:ec:ef:1a:2b:3c',
      pxeInterface: 'eth0',
      pxeMacSource: 'address',
      candidateMacs: [],
      zoneId: ZONE,
      trail,
      bootExpected: { expected: true, since: NOW, reason: 'active-job' },
      readAt: NOW,
    });
    expect(parsed.trail.pxe?.outcome).toBe('offered');
  });

  it('rejects a pxe decision hash whose at is not digits', () => {
    expect(PxeDecisionHashSchema.safeParse({ outcome: 'offered', at: 'now' }).success).toBe(false);
  });

  it('parses a readiness response', () => {
    const parsed = DeviceBootReadinessSchema.parse({
      deviceId: DEVICE,
      prefixId: null,
      prefixSelection: 'none',
      pxeMac: null,
      pxeInterface: 'eth0',
      pxeMacSource: 'address',
      bmcAddress: null,
      findings: [{ code: 'PXE-107', severity: 'warn', message: 'no prefix', source: 'hub-prefix', prefixId: null }],
      evaluated: { hubPrefix: false, bootTrail: true, bootedWithoutDhcp: false },
      trail,
    });
    expect(parsed.findings[0]?.code).toBe('PXE-107');
  });
});

describe('health schemas', () => {
  it('parses a tri-state health check row', () => {
    const parsed = DeviceHealthCheckSchema.parse({
      id: 'hc-1',
      testedAt: NOW,
      primaryReachable: true,
      bmcIcmpReachable: true,
      bmcIpmiReachable: true,
      bmcRedfishReachable: true,
      bmcCredsValid: false,
      poweredOn: true,
      brokkrLiveRunning: null,
      reachability: 'auth-failed',
    });
    expect(parsed.brokkrLiveRunning).toBeNull();
  });

  it('parses an empty summary', () => {
    const parsed = DeviceHealthSummarySchema.parse({
      view: 'owner',
      source: 'none',
      checkedAt: null,
      checks: null,
      isHealthy: null,
      reason: null,
      icmpFiltered: false,
    });
    expect(parsed.isHealthy).toBeNull();
  });
});

describe('job events and token summaries', () => {
  it('parses a truncated events page', () => {
    const parsed = LifecycleJobEventsResponseSchema.parse({
      data: [
        {
          id: 'e-1',
          sagaName: 'provision',
          stepName: 'power_cycle',
          operation: 'Power cycle the server',
          eventType: 'job_failed',
          status: 'failed',
          result: 'not-an-object',
          error: 'BMC did not answer',
          attempt: 1,
          occurredAt: NOW,
          recordedAt: NOW,
          origin: 'bridge',
        },
      ],
      meta: { truncated: true, cap: 500 },
    });
    expect(parsed.meta.truncated).toBe(true);
    expect(parsed.data[0].operation).toBe('Power cycle the server');
  });

  it('strips revokedNote and issuedBy from a token summary', () => {
    const summary = DeviceTokenSummarySchema.parse({
      id: '33333333-3333-3333-3333-333333333333',
      deviceId: DEVICE,
      context: 'BROKKR_LIVE',
      displayId: 'ab12',
      status: 'ACTIVE',
      rotationGeneration: 0,
      expiresAt: null,
      lastUsedAt: NOW,
      lastUsedIp: '10.40.1.23',
      revokedAt: null,
      revokedReason: null,
      createdAt: NOW,
    });
    expect('issuedBy' in summary).toBe(false);
  });
});
