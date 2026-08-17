import { DeviceRole } from '@repo/database';

// Exhaustive by construction (Record<DeviceRole, …>) so a new role fails the build here.
// `null` = no netplan family branches on the role; `shouldVlanTag` reads it as "do not tag".
const NETPLAN_ROLE_SLUG: Record<DeviceRole, string | null> = {
  [DeviceRole.Baremetal]: 'marketplace-hosts',
  // Shares Baremetal's slug: both are in `NEVER_TAG_ROLES`, so this is
  // behaviour-neutral against the `null` it used to fall through to.
  [DeviceRole.Server]: 'marketplace-hosts',
  [DeviceRole.Hypervisor]: 'hypervisor',
  [DeviceRole.VM]: 'virtual-bmc',
  [DeviceRole.Bridge]: 'brokkr-bridge',
  [DeviceRole.Decommissioned]: 'decommissioned-hosts',
  [DeviceRole.DiscoveredHost]: 'discovered-hosts',
  [DeviceRole.OffMarketplaceHost]: 'off-marketplace-hosts',

  // No host netplan — see the note above before giving any of these a slug.
  [DeviceRole.Cluster]: null,
  [DeviceRole.NetworkSwitch]: null,
  [DeviceRole.Switch]: null,
  [DeviceRole.Router]: null,
  [DeviceRole.PDU]: null,
  [DeviceRole.CDU]: null,
  [DeviceRole.RackBrush]: null,
  [DeviceRole.PatchPanel]: null,
};

/** Returns null for an unset role, and for roles with no host netplan. */
export function mapRoleToNetplanSlug(role: DeviceRole | null): string | null {
  return role === null ? null : NETPLAN_ROLE_SLUG[role];
}

/** Whether the device renders with one of the bridge families. */
export function roleGetsBridge(role: DeviceRole | null): boolean {
  return role === DeviceRole.Bridge;
}
