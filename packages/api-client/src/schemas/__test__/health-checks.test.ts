import { describe, expect, it } from 'vitest';
import { CUSTOMER_HEALTH_KEYS, DeviceHealthSnapshotSchema } from '../health-checks';

const DEVICE = '22222222-2222-2222-2222-222222222222';

const snapshot = {
  device_id: DEVICE,
  primary_reachable: true,
  bmc_icmp_reachable: false,
  bmc_ipmi_reachable: null,
  bmc_redfish_reachable: null,
  bmc_creds_valid: null,
  powered_on: true,
  brokkr_live_running: null,
  checked_at: 1_789_500_000.5,
};

describe('DeviceHealthSnapshotSchema', () => {
  it('parses a bridge snapshot with a fractional epoch and null probes', () => {
    const parsed = DeviceHealthSnapshotSchema.parse(snapshot);
    expect(parsed.checked_at).toBe(1_789_500_000.5);
    expect(parsed.bmc_ipmi_reachable).toBeNull();
  });

  it('rejects a checked_at that is not a number', () => {
    expect(DeviceHealthSnapshotSchema.safeParse({ ...snapshot, checked_at: '1789500000' }).success).toBe(false);
  });

  it('rejects a snapshot missing a probe field', () => {
    const { powered_on: _omitted, ...rest } = snapshot;
    expect(DeviceHealthSnapshotSchema.safeParse(rest).success).toBe(false);
  });
});

describe('CUSTOMER_HEALTH_KEYS', () => {
  it('exposes only the primary ping and the power state to a customer', () => {
    expect([...CUSTOMER_HEALTH_KEYS].sort()).toEqual(['poweredOn', 'primaryReachable']);
  });
});
