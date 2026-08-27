#!/usr/bin/env python
"""Generator: sim ``Vlan`` + admin-visible ``IpRange`` rows → SQL.

``47-vrfs-vlan-groups`` seeds VRF + VLAN groups but no VLANs; ``46-prefixes`` only
emits an ``IpRange`` when DHCP is on (dynamic pool). Admin IPAM list/create/edit
needs always-on VLAN + range inventory. Per zone: data/mgmt/reserved VLANs, tied
to that zone's VLAN group, with the vid stepped by the zone index so the one sim
VRF stays unique. The admin pools and the prefix→VLAN links describe the shared
subnet, so they belong to the zone that owns its prefixes (``IPAM_OWNER_INDEX``).
Numbering: 48 > 47."""

from __future__ import annotations

import ipaddress
import uuid
from pathlib import Path

import yaml
from local.config import get_settings
from local.derived import LOCAL_NS
from local.sqlemit import header, logs_to_stderr, q
from local.zones import IPAM_OWNER_INDEX, zone_uuid

# (slug, display name, VID, IpamRole|None, VlanStatus, attach_to_prefix_slug|None)
_VLANS = [
    ("data", "sim-data", 100, "PRIMARY", "ACTIVE", "primary"),
    ("management", "sim-management", 200, "MANAGEMENT", "ACTIVE", "management"),
    ("reserved", "sim-reserved", 300, None, "RESERVED", None),
]

# (slug, purpose, fleet network key, prefix slug, start_offset, end_offset)
_RANGES = [
    ("primary-admin", "sim-admin-pool", "cidr", "primary", 100, 109),
    ("mgmt-admin", "sim-bmc-admin-pool", "bmc_cidr", "management", 100, 109),
]


def _vrf_uuid(org_id: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"vrf:{org_id}:default"))


def _vlan_group_uuid(zone_id: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"vlan-group:{zone_id}"))


def _prefix_uuid(zone_id: str, slug: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"prefix:{zone_id}:{slug}"))


def _vlan_uuid(zone_id: str, slug: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"vlan:{zone_id}:{slug}"))


def _range_uuid(zone_id: str, slug: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"ip-range:{zone_id}:{slug}"))


def _vlan_sql(
    vlan_id: str,
    name: str,
    vid: int,
    status: str,
    role: str | None,
    org_id: str,
    vrf_id: str,
    zone_id: str,
    vlan_group_id: str,
) -> str:
    role_sql = f'{q(role)}::"IpamRole"' if role else "NULL"
    return f"""-- VLAN {name} vid={vid} zone={zone_id}
INSERT INTO "Vlan" (
    id, name, vid, description, status, role,
    "organizationId", "vrfId", "zoneId", "vlanGroupId",
    "createdAt", "updatedAt"
) VALUES (
    {q(vlan_id)}, {q(name)}, {vid},
    {q(f"Sim VLAN {name} (seeded for admin IPAM)")},
    {q(status)}::"VlanStatus", {role_sql},
    {q(org_id)}, {q(vrf_id)}, {q(zone_id)}, {q(vlan_group_id)},
    NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    vid = EXCLUDED.vid,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    role = EXCLUDED.role,
    "organizationId" = EXCLUDED."organizationId",
    "vrfId" = EXCLUDED."vrfId",
    "zoneId" = EXCLUDED."zoneId",
    "vlanGroupId" = EXCLUDED."vlanGroupId",
    "deletedAt" = NULL,
    "updatedAt" = NOW();
"""


def _attach_prefix_vlan_sql(prefix_id: str, vlan_id: str) -> str:
    return f"""-- link prefix {prefix_id} → VLAN {vlan_id}
UPDATE "Prefix"
SET "vlanId" = {q(vlan_id)}, "updatedAt" = NOW()
WHERE id = {q(prefix_id)} AND "deletedAt" IS NULL;
"""


def _range_sql(
    range_id: str,
    start: str,
    end: str,
    purpose: str,
    org_id: str,
    prefix_id: str,
    vrf_id: str,
    zone_id: str,
) -> str:
    return f"""-- IP range {purpose} {start}-{end} prefix={prefix_id}
INSERT INTO "IpRange" (
    id, start, "end", status, purpose,
    "organizationId", "prefixId", "vrfId", "zoneId",
    "createdAt", "updatedAt"
) VALUES (
    {q(range_id)}, {q(start)}::inet, {q(end)}::inet, 'ACTIVE'::"IpRangeStatus", {q(purpose)},
    {q(org_id)}, {q(prefix_id)}, {q(vrf_id)}, {q(zone_id)},
    NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    start = EXCLUDED.start,
    "end" = EXCLUDED."end",
    status = EXCLUDED.status,
    purpose = EXCLUDED.purpose,
    "organizationId" = EXCLUDED."organizationId",
    "prefixId" = EXCLUDED."prefixId",
    "vrfId" = EXCLUDED."vrfId",
    "zoneId" = EXCLUDED."zoneId",
    "deletedAt" = NULL,
    "updatedAt" = NOW();
"""


def _attach_dhcp_pool_vrf_sql(vrf_id: str, zone_id: str) -> str:
    """DHCP pools from 46 lack vrfId/purpose — backfill so they show under the sim VRF."""
    pool_id = str(uuid.uuid5(LOCAL_NS, f"dhcp-pool:{zone_id}"))
    return f"""-- attach DHCP dynamic pool (if present) to sim VRF
UPDATE "IpRange"
SET "vrfId" = {q(vrf_id)},
    purpose = COALESCE(purpose, 'dhcp-dynamic-pool'),
    "updatedAt" = NOW()
WHERE id = {q(pool_id)} AND "deletedAt" IS NULL;
"""


def generate() -> str:
    s = get_settings()
    org_id = s.sim.hydrahost_org_id
    fleet = yaml.safe_load(Path(s.paths.fleet_path).read_text())
    network = fleet["network"]
    zones_meta = fleet.get("zones") or [{"index": 0, "name": s.sim.zone_name}]

    vrf_id = _vrf_uuid(org_id)
    out: list[str] = [header("48-vlans-ip-ranges.py"), "BEGIN;\n\n"]

    for z in sorted(zones_meta, key=lambda zz: zz["index"]):
        zid = zone_uuid(z["index"])
        zname = z["name"]
        group_id = _vlan_group_uuid(zid)

        for slug, display, vid, role, status, prefix_slug in _VLANS:
            vlan_id = _vlan_uuid(zid, slug)
            name = f"{zname}-{display}"
            # Vlan_active_unique_vid is (org, vrfId, vid) and every zone shares the one sim VRF, so
            # the vid steps with the zone index. Base vids are 100 apart and indices stop at 88.
            out.append(_vlan_sql(vlan_id, name, vid + z["index"], status, role, org_id, vrf_id, zid, group_id))
            if prefix_slug and z["index"] == IPAM_OWNER_INDEX:
                out.append(_attach_prefix_vlan_sql(_prefix_uuid(zid, prefix_slug), vlan_id))

        out.append("\n")
        # The admin pools carve up the shared subnet, so they belong to the zone that owns its
        # prefixes. A pool per zone would be the same address range against a missing prefix.
        if z["index"] != IPAM_OWNER_INDEX:
            continue
        for slug, purpose, net_key, prefix_slug, start_off, end_off in _RANGES:
            net = ipaddress.ip_network(network[net_key], strict=False)
            if start_off >= net.num_addresses - 1 or end_off >= net.num_addresses - 1:
                raise ValueError(
                    f"admin IP range offsets {start_off}-{end_off} do not fit in {net} (zone={zid}, slug={slug})"
                )
            start = str(net.network_address + start_off)
            end = str(net.network_address + end_off)
            out.append(
                _range_sql(
                    _range_uuid(zid, slug),
                    start,
                    end,
                    purpose,
                    org_id,
                    _prefix_uuid(zid, prefix_slug),
                    vrf_id,
                    zid,
                )
            )

        out.append(_attach_dhcp_pool_vrf_sql(vrf_id, zid))
        out.append("\n")

    out.append("COMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
