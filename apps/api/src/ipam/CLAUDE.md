# IPAM Domain (IP Address Management)

IPAM is the "phone book" for network addresses. It tracks every IP address, subnet, VLAN, and routing table in the infrastructure -- answering questions like "which IPs exist?", "which device has which address?", and "are there any address conflicts?"

## Entities

### VRF (Virtual Routing and Forwarding)

A namespace for IP addresses. Normally, every IP must be unique -- but VRFs let you have overlapping ranges. Two different customers can both use 10.0.0.0/24 as long as each lives in a separate VRF. Think of it as a logical routing table that keeps address spaces isolated. The `rd` (Route Distinguisher, e.g. "65000:1") is a BGP identifier that uniquely tags routes from this VRF when they cross network boundaries.

### Prefix

A subnet written in CIDR notation (e.g., 10.0.0.0/24 = 256 addresses). Prefixes form a tree -- a /16 can contain many /24s, tracked via `parentId`. Each prefix has a role describing its purpose (`IpamRole` enum, aligned with the `IpamPrefixVlanRole` slug catalog):

- **ALLOCATION** / **COMMON** / **LOOPBACK** -- general addressing roles carried over from the NetBox catalog
- **MANAGEMENT** -- out-of-band device management; a zone-scoped MANAGEMENT prefix is what the commissioning network scan enumerates
- **NAT** -- prefixes holding NAT outside addresses
- **PRIMARY** -- the primary data-plane subnet

Netplan rendering additionally reads three per-prefix knobs: `prefixRoleId` (link into the `IpamPrefixVlanRole` slug catalog — drives VLAN route metrics), `enableVlanTag` (force VLAN tagging regardless of device role), and `bondParameters` (JSON emitted for bonded interfaces).

And a status describing its lifecycle:

- **CONTAINER** -- a parent-only block that is never directly assigned; it exists solely to hold child prefixes
- **ACTIVE** -- in use
- **RESERVED** -- earmarked for future use
- **DEPRECATED** -- being phased out

When `isPool` is true, individual IPs can be auto-allocated from that prefix.

### IpAddress

A single IP address (e.g., 10.0.0.5) within a prefix. Has a status (ACTIVE, RESERVED, DEPRECATED, DHCP) and an optional `dnsName` for reverse DNS. An IP address can be assigned to an Interface (a network port on a physical device) -- this is the primary link between IPAM and DCIM.

### IpRange

A contiguous block of IPs within a prefix (e.g., 10.0.0.100 to 10.0.0.200). Used for DHCP pools, reserved allocation blocks, or any scenario where you need to carve out a range without creating individual IP records. Must be fully contained within its parent prefix.

### VLAN (Virtual LAN)

A layer-2 broadcast domain identified by a VID (1--4094, per IEEE 802.1Q). Devices on the same VLAN can talk to each other at the ethernet level without routing. VLANs map to prefixes -- a VLAN carries traffic for one or more subnets. A VLAN can optionally belong to a VRF, and when it does, its VRF must match the VRF of any prefix it's associated with.

### VlanGroup

A scoping container that prevents VLAN ID collisions across zones. VID 100 in Zone A is a completely different VLAN from VID 100 in Zone B. Each group defines an allowed VID range (`minVid`/`maxVid`). Defined in `asn.prisma`, not `ipam.prisma`.

## Key Relationships

- **VRF** scopes Prefixes, IpAddresses, VLANs, and IpRanges. All VRF-scoped entities within a relationship must share the same VRF (or all be global/null VRF).
- **Prefix** hierarchy is self-referential via `parentId`. A child prefix must be strictly contained within its parent's CIDR range and share the same VRF.
- **Prefix** can have a gateway IP (the default route for the subnet), which must be an IpAddress within that prefix's range.
- **IpAddress** connects to DCIM via `interfaceId` -- this is how "which device has which IP" is tracked.
- **IpRange** belongs to exactly one Prefix and must be fully contained within it.
- **VLAN** is scoped by VlanGroup and associated with Prefixes.
- Everything is scoped to an Organization (multi-tenant).

## Non-Obvious Implementation Details

**Raw SQL is required for CIDR/inet operations.** Prefix stores its value as PostgreSQL native `cidr` and IpAddress uses native `inet`. Prisma does not support these types, so all containment checks, overlap detection, normalization, and range comparisons use `$queryRaw` with PostgreSQL's network operators (`<<`, `>>=`, etc.). This is why the repositories extend `BaseIpamRepository` rather than using standard Prisma methods.

**Audit logging is built in.** Every create, update, and delete on IPAM entities writes a Changelog record with before/after snapshots and a computed diff. The `IpamChangelogService` exposes this as a queryable timeline.

**Prefix utilization is calculated, not stored.** The repository computes how full a prefix is on-demand by counting assigned IPs relative to the prefix's total capacity.

**Next-prefix allocation is atomic.** `allocateNextPrefix` finds the first available sub-prefix of a given size within a parent container and creates it in a single operation, avoiding race conditions.

**Overlap detection is a first-class operation.** Before creating or updating a prefix, the system checks for CIDR overlaps within the same VRF using PostgreSQL's `&&` (overlap) operator.

## Connection to DCIM

IpAddresses are assigned to Interfaces (network ports on physical devices). This is the bridge between "which IPs exist" (IPAM) and "which device has which port" (DCIM). Device-side DHCP cleanup (removing reservations and leases when a device is deprovisioned) is **not implemented** — the former `src/ipam-device/` stub was removed, and no code currently performs this cleanup.

## Ownership

These entities are Brokkr-owned: the Brokkr database is the sole source of truth. There is no NetBox sync — the `netboxId` columns have been removed and nothing dual-writes anywhere. The schema shape still echoes NetBox's IPAM module (the system Brokkr replaced). The IpAddress model still has legacy polymorphic fields (`assignedObjectType`, `assignedObjectId`) alongside the newer direct `interfaceId` foreign key -- the polymorphic fields are slated for removal once all readers cut over.
