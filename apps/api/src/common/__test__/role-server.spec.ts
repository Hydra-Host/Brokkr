import { DeviceRole } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { SERVER_ROLES, roleGetsServer } from '../role-server';

describe('roleGetsServer', () => {
  it.each([
    DeviceRole.Baremetal,
    DeviceRole.Hypervisor,
    DeviceRole.Cluster,
    DeviceRole.DiscoveredHost,
    DeviceRole.OffMarketplaceHost,
    DeviceRole.Decommissioned,
  ])('returns true for compute-host role %s', (role) => {
    expect(roleGetsServer(role)).toBe(true);
  });

  it.each([DeviceRole.Bridge, DeviceRole.VM, DeviceRole.NetworkSwitch])(
    'returns false for non-host role %s',
    (role) => {
      expect(roleGetsServer(role)).toBe(false);
    },
  );

  it('returns false for null role (unset)', () => {
    expect(roleGetsServer(null)).toBe(false);
  });

  it('exports SERVER_ROLES as the same set used by the helper', () => {
    expect(SERVER_ROLES.size).toBeGreaterThan(0);
    for (const role of SERVER_ROLES) {
      expect(roleGetsServer(role)).toBe(true);
    }
  });
});

