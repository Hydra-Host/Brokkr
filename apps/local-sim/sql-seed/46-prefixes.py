#!/usr/bin/env python
"""Generator: per-zone ``IpamPrefixVlanRole`` + ``Prefix`` rows (primary + management) → SQL.

The ``prefixRole`` slug (not the coarse ``IpamRole`` enum) is what the hub's netplan planner reads. When
``network.dhcp`` is set the PRIMARY prefix gets ``dhcpMode=AUTHORITATIVE`` + a gateway IP + client pool; off
leaves ``dhcpMode`` NULL so the reconciler clears the atom. Zone 0's management prefix gets a harmless
``Gateway`` catalog fixture for admin CRUD testing. Resolves ``organizationId`` from the ``Zone`` row, so 46 > 45."""

from __future__ import annotations

import ipaddress
import uuid

from local.derived import LOCAL_NS, NODE_IP_BASE
from local.schema import require_fleet
from local.sqlemit import header, logs_to_stderr, q
from local.zones import zone_uuid

# (slug, display name, IpamRole enum, Network field). The enum is set for
# parity with the hub catalog; the slug is what netplan actually consumes.
_ROLES = [
    ("primary", "Primary", "PRIMARY", "cidr"),
    ("management", "Management", "MANAGEMENT", "bmc_cidr"),
]


def _prefix_uuid(zone_id: str, slug: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"prefix:{zone_id}:{slug}"))


def _role_sql(slug: str, name: str) -> str:
    return f"""-- prefix/vlan role {slug}
INSERT INTO "IpamPrefixVlanRole" (id, name, slug, weight, "updatedAt")
VALUES (gen_random_uuid(), {q(name)}, {q(slug)}, 1000, NOW())
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = NOW();
"""


def _gateway_ip_sql(gw_ip_id: str, gw_addr: str, prefixlen: int, zone_id: str) -> str:
    org = f'(SELECT "organizationId" FROM "Zone" WHERE id = {q(zone_id)})'
    return f"""-- Unattached gateway IP (no interface → not a reservation)
INSERT INTO "IpAddress" (id, address, status, "organizationId", "updatedAt")
VALUES ({q(gw_ip_id)}, {q(f"{gw_addr}/{prefixlen}")}::inet, 'ACTIVE'::"IpStatus", {org}, NOW())
ON CONFLICT (id) DO UPDATE SET
    address = EXCLUDED.address, status = EXCLUDED.status,
    "organizationId" = EXCLUDED."organizationId", "updatedAt" = NOW();
"""


def _rendered_gateway_delete_sql(gw_id: str, gw_ip_id: str) -> str:
    """Drop the rendered-netplan gateway so toggling ``rendered_netplan`` off converges."""
    return f"""-- rendered_netplan off: remove the primary-prefix gateway
DELETE FROM "Gateway" WHERE id = {q(gw_id)};
DELETE FROM "IpAddress" WHERE id = {q(gw_ip_id)};
"""


def _gateway_row_sql(gw_id: str, gw_ip_id: str, prefix_id: str) -> str:
    """A ``Gateway`` on a prefix.

    Two callers: the management-prefix fixture (admin CRUD testing only — IPMI interfaces are
    excluded from netplan by name), and the primary prefix under ``rendered_netplan``, where it is
    load-bearing: it is the row the hub's planner resolves a default route from.

    ``vrfId`` is written NULL here and re-pointed at the prefix's VRF by ``47-vrfs-vlan-groups``,
    which is what assigns prefixes a VRF in the first place. The planner matches gateway VRF against
    ``ip.vrfId ?? prefix.vrfId``, so leaving it NULL would silently yield no route.
    """
    return f"""-- Gateway on prefix {prefix_id}
INSERT INTO "Gateway" (id, "routingPriority", "vrfId", "gatewayIpId", "prefixId", "createdAt", "updatedAt")
VALUES ({q(gw_id)}, 100, NULL, {q(gw_ip_id)}, {q(prefix_id)}, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    "gatewayIpId" = EXCLUDED."gatewayIpId", "prefixId" = EXCLUDED."prefixId",
    "routingPriority" = EXCLUDED."routingPriority", "updatedAt" = NOW();
"""


def _prefix_sql(
    prefix_id: str,
    cidr: str,
    role_enum: str,
    slug: str,
    zone_id: str,
    *,
    dhcp: bool = False,
    gw_ip_id: str | None = None,
) -> str:
    org = f'(SELECT "organizationId" FROM "Zone" WHERE id = {q(zone_id)})'
    role_id = f'(SELECT id FROM "IpamPrefixVlanRole" WHERE slug = {q(slug)})'
    # DHCP columns always written (real on the DHCP primary; NULL otherwise) so toggling dhcp off
    # converges — dhcpMode NULL → reconciler clears the atom. DNS is bridge-derived (no hub column).
    dhcp_mode = "'AUTHORITATIVE'::\"DhcpMode\"" if dhcp else "NULL"
    gateway_ip = q(gw_ip_id) if (dhcp and gw_ip_id) else "NULL"
    label = " (DHCP AUTHORITATIVE)" if dhcp else ""
    return f"""-- {slug} prefix {cidr} → zone={zone_id}{label}
INSERT INTO "Prefix" (
    id, prefix, status, "isPool", role,
    "organizationId", "zoneId", "prefixRoleId",
    "dhcpMode", "gatewayIpId",
    "createdAt", "updatedAt"
) VALUES (
    {q(prefix_id)}, {q(cidr)}::cidr, 'ACTIVE'::"PrefixStatus", false, {q(role_enum)}::"IpamRole",
    {org}, {q(zone_id)}, {role_id},
    {dhcp_mode}, {gateway_ip},
    NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    prefix = EXCLUDED.prefix, status = EXCLUDED.status, role = EXCLUDED.role,
    "organizationId" = EXCLUDED."organizationId", "zoneId" = EXCLUDED."zoneId",
    "prefixRoleId" = EXCLUDED."prefixRoleId",
    "dhcpMode" = EXCLUDED."dhcpMode", "gatewayIpId" = EXCLUDED."gatewayIpId",
    "updatedAt" = NOW();
"""


def _pool_sql(pool_id: str, prefix_id: str, start: str, end: str, zone_id: str) -> str:
    org = f'(SELECT "organizationId" FROM "Zone" WHERE id = {q(zone_id)})'
    return f"""-- DHCP dynamic pool for non-reserved clients (reservations derive from device eth0 IPs)
INSERT INTO "IpRange" (id, start, "end", status, "organizationId", "prefixId", "zoneId", "updatedAt")
VALUES ({q(pool_id)}, {q(start)}::inet, {q(end)}::inet, 'ACTIVE'::"IpRangeStatus",
    {org}, {q(prefix_id)}, {q(zone_id)}, NOW())
ON CONFLICT (id) DO UPDATE SET
    start = EXCLUDED.start, "end" = EXCLUDED."end", status = EXCLUDED.status,
    "organizationId" = EXCLUDED."organizationId", "prefixId" = EXCLUDED."prefixId",
    "zoneId" = EXCLUDED."zoneId", "updatedAt" = NOW();
"""


def _dhcp_pool_offsets(net: ipaddress.IPv4Network, node_count: int) -> tuple[int, int]:
    """DHCP pool offsets provably disjoint from device reservations (5-addr margin above the
    reservation block); raises ValueError if a 2-addr pool can't fit."""
    _DEVICE_BASE = NODE_IP_BASE
    _MARGIN = 5
    _POOL_SIZE = 50
    # Highest device reservation offset (0-based node index → offset 10+i).
    last_device_offset = _DEVICE_BASE + max(node_count - 1, 0)
    # Pool must start above the reservation block + margin.
    min_pool_start = last_device_offset + _MARGIN + 1
    # On wide subnets prefer starting at offset 200 (legacy position) for readability,
    # but never below the reservation-safe floor.
    pool_start_offset = max(min_pool_start, min(200, net.num_addresses - 3))
    pool_end_offset = min(pool_start_offset + _POOL_SIZE, net.num_addresses - 2)
    if pool_start_offset >= net.num_addresses - 2 or pool_end_offset <= pool_start_offset:
        raise ValueError(
            f"DHCP pool cannot fit in {net} with {node_count} device reservations "
            f"(last reservation at offset {last_device_offset}, "
            f"need at least offset {min_pool_start + 1} for a minimal pool) — "
            "use a wider data-plane CIDR or fewer nodes"
        )
    return pool_start_offset, pool_end_offset


def generate() -> str:
    fleet = require_fleet()
    network = fleet.network
    dhcp_enabled = network.dhcp
    node_count = len(fleet.nodes)

    out: list[str] = [header("46-prefixes.py"), "BEGIN;\n\n"]
    for slug, name, _enum, _key in _ROLES:
        out.append(_role_sql(slug, name))
    out.append("\n")
    for z in sorted(fleet.zones, key=lambda zz: zz.index):
        zid = zone_uuid(z.index)
        for slug, _name, role_enum, net_field in _ROLES:
            cidr = getattr(network, net_field)
            prefix_id = _prefix_uuid(zid, slug)
            # DHCP served only on the primary prefix, only when opted in, and only for zone 0: all zones
            # share one network.cidr, so a pool per zone would publish duplicate DHCP atoms for the same subnet.
            if dhcp_enabled and slug == "primary" and z.index == 0:
                net = ipaddress.ip_network(cidr, strict=False)
                gw_ip_id = str(uuid.uuid5(LOCAL_NS, f"dhcp-gw:{zid}"))
                out.append(_gateway_ip_sql(gw_ip_id, str(net.network_address + 1), net.prefixlen, zid))
                out.append(_prefix_sql(prefix_id, cidr, role_enum, slug, zid, dhcp=True, gw_ip_id=gw_ip_id))
                pool_id = str(uuid.uuid5(LOCAL_NS, f"dhcp-pool:{zid}"))
                pool_start_offset, pool_end_offset = _dhcp_pool_offsets(net, node_count)
                pool_start = str(net.network_address + pool_start_offset)
                pool_end = str(net.network_address + pool_end_offset)
                out.append(_pool_sql(pool_id, prefix_id, pool_start, pool_end, zid))
            else:
                out.append(_prefix_sql(prefix_id, cidr, role_enum, slug, zid))
                if slug == "primary":
                    # Emitted either way so toggling rendered_netplan converges in both directions.
                    net = ipaddress.ip_network(cidr, strict=False)
                    gw_ip_id = str(uuid.uuid5(LOCAL_NS, f"rendered-gw-ip:{zid}"))
                    gw_id = str(uuid.uuid5(LOCAL_NS, f"rendered-gw:{zid}"))
                    if network.rendered_netplan:
                        out.append(_gateway_ip_sql(gw_ip_id, str(net.network_address + 1), net.prefixlen, zid))
                        out.append(_gateway_row_sql(gw_id, gw_ip_id, prefix_id))
                    else:
                        out.append(_rendered_gateway_delete_sql(gw_id, gw_ip_id))
                if slug == "management" and z.index == 0:
                    net = ipaddress.ip_network(cidr, strict=False)
                    fixture_ip_id = str(uuid.uuid5(LOCAL_NS, f"gateway-fixture-ip:{zid}"))
                    fixture_id = str(uuid.uuid5(LOCAL_NS, f"gateway-fixture:{zid}"))
                    out.append(
                        _gateway_ip_sql(fixture_ip_id, str(net.network_address + 2), net.prefixlen, zid),
                    )
                    out.append(_gateway_row_sql(fixture_id, fixture_ip_id, prefix_id))
    out.append("COMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
