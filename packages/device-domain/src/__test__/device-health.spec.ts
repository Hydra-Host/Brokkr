import { describe, expect, it } from 'vitest';
import { deriveReachability, healthReason, isIcmpFiltered, type HealthChecks } from '../device-health';

const checks = (over: Partial<HealthChecks> = {}): HealthChecks => ({
  primaryReachable: true,
  bmcIcmpReachable: true,
  bmcIpmiReachable: true,
  bmcRedfishReachable: true,
  bmcCredsValid: true,
  poweredOn: true,
  brokkrLiveRunning: null,
  ...over,
});

describe('deriveReachability', () => {
  it('is unconfigured when every BMC probe was skipped', () => {
    expect(
      deriveReachability(checks({ bmcIcmpReachable: null, bmcIpmiReachable: null, bmcRedfishReachable: null })),
    ).toBe('unconfigured');
  });

  it('is unreachable when no BMC probe answered', () => {
    expect(
      deriveReachability(checks({ bmcIcmpReachable: false, bmcIpmiReachable: false, bmcRedfishReachable: null })),
    ).toBe('unreachable');
  });

  it('is auth-failed when a probe answered and the credential was rejected', () => {
    expect(deriveReachability(checks({ bmcCredsValid: false }))).toBe('auth-failed');
  });

  it('is ok when a probe answered and the credential was accepted', () => {
    expect(deriveReachability(checks())).toBe('ok');
  });

  it('is unknown when a probe answered and the credential was not tested', () => {
    expect(deriveReachability(checks({ bmcCredsValid: null }))).toBe('unknown');
  });
});

describe('isIcmpFiltered', () => {
  it('is true when icmp fails but ipmi or redfish answers', () => {
    expect(isIcmpFiltered(checks({ bmcIcmpReachable: false }))).toBe(true);
    expect(isIcmpFiltered(checks({ bmcIcmpReachable: null, bmcIpmiReachable: false }))).toBe(true);
  });

  it('is false when icmp answers or when no bmc transport answers', () => {
    expect(isIcmpFiltered(checks())).toBe(false);
    expect(
      isIcmpFiltered(checks({ bmcIcmpReachable: false, bmcIpmiReachable: false, bmcRedfishReachable: false })),
    ).toBe(false);
    expect(isIcmpFiltered(checks({ bmcIcmpReachable: null, bmcIpmiReachable: null, bmcRedfishReachable: null }))).toBe(
      false,
    );
  });
});

describe('healthReason', () => {
  it('names the first failing probe and honors eco mode', () => {
    expect(healthReason(checks(), false)).toBeNull();
    expect(healthReason(checks({ bmcIpmiReachable: null }), false)).toBe('BMC not accessible via IPMI');
    expect(healthReason(checks({ bmcRedfishReachable: false }), false)).toBe('BMC not accessible via Redfish API');
    expect(healthReason(checks({ bmcCredsValid: false }), false)).toBe('BMC credentials are invalid');
    expect(healthReason(checks({ poweredOn: false }), false)).toBe('Device is not powered on');
    expect(healthReason(checks({ poweredOn: false }), true)).toBeNull();
  });

  it('names ICMP only when no BMC transport answered', () => {
    expect(
      healthReason(checks({ bmcIcmpReachable: false, bmcIpmiReachable: false, bmcRedfishReachable: false }), false),
    ).toBe('BMC interface not reachable via ICMP');
    expect(
      healthReason(checks({ bmcIcmpReachable: null, bmcIpmiReachable: null, bmcRedfishReachable: null }), false),
    ).toBe('BMC interface not reachable via ICMP');
  });

  it('skips the ICMP rung when IPMI answered', () => {
    expect(healthReason(checks({ bmcIcmpReachable: false }), false)).toBeNull();
    expect(healthReason(checks({ bmcIcmpReachable: false, bmcRedfishReachable: false }), false)).toBe(
      'BMC not accessible via Redfish API',
    );
  });

  it('skips the ICMP rung when Redfish answered', () => {
    expect(healthReason(checks({ bmcIcmpReachable: null, bmcIpmiReachable: false }), false)).toBe(
      'BMC not accessible via IPMI',
    );
    expect(healthReason(checks({ bmcIcmpReachable: null, bmcIpmiReachable: null }), false)).toBe(
      'BMC not accessible via IPMI',
    );
  });
});
