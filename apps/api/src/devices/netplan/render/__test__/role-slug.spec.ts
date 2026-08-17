import { DeviceRole } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { mapRoleToNetplanSlug } from '../role-slug';

const NEVER_TAG_ROLES = new Set(['marketplace-hosts', 'decommissioned-hosts', 'discovered-hosts']);

describe('mapRoleToNetplanSlug', () => {
  it('maps every DeviceRole — a new enum member cannot slip through untested', () => {
    // Iterating the enum rather than listing cases is the point: adding a role
    // fails the build at the Record, and fails here if it is left unconsidered.
    for (const role of Object.values(DeviceRole)) {
      const slug = mapRoleToNetplanSlug(role);
      expect(slug === null || (typeof slug === 'string' && slug.length > 0)).toBe(true);
    }
  });

  it('returns null for an unset role', () => {
    expect(mapRoleToNetplanSlug(null)).toBeNull();
  });

  it('pins the host roles the templates actually branch on', () => {
    expect(mapRoleToNetplanSlug(DeviceRole.Baremetal)).toBe('marketplace-hosts');
    expect(mapRoleToNetplanSlug(DeviceRole.Server)).toBe('marketplace-hosts');
    expect(mapRoleToNetplanSlug(DeviceRole.Hypervisor)).toBe('hypervisor');
    expect(mapRoleToNetplanSlug(DeviceRole.VM)).toBe('virtual-bmc');
    expect(mapRoleToNetplanSlug(DeviceRole.Bridge)).toBe('brokkr-bridge');
    expect(mapRoleToNetplanSlug(DeviceRole.Decommissioned)).toBe('decommissioned-hosts');
    expect(mapRoleToNetplanSlug(DeviceRole.DiscoveredHost)).toBe('discovered-hosts');
    expect(mapRoleToNetplanSlug(DeviceRole.OffMarketplaceHost)).toBe('off-marketplace-hosts');
  });

  it('leaves fabric and facility roles unmapped so they never start VLAN-tagging', () => {
    // These have no host netplan. Giving them a slug outside NEVER_TAG_ROLES
    // would flip them to tagged, which is why they are deliberately null.
    for (const role of [
      DeviceRole.Cluster,
      DeviceRole.NetworkSwitch,
      DeviceRole.Switch,
      DeviceRole.Router,
      DeviceRole.PDU,
      DeviceRole.CDU,
      DeviceRole.RackBrush,
      DeviceRole.PatchPanel,
    ]) {
      expect(mapRoleToNetplanSlug(role)).toBeNull();
    }
  });

  it('keeps Server and Baremetal on the same side of the VLAN-tag decision', () => {
    const server = mapRoleToNetplanSlug(DeviceRole.Server);
    const baremetal = mapRoleToNetplanSlug(DeviceRole.Baremetal);
    expect(NEVER_TAG_ROLES.has(server!)).toBe(true);
    expect(NEVER_TAG_ROLES.has(baremetal!)).toBe(true);
  });
});
