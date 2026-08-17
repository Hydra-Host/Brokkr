#!/usr/bin/env python
"""Generator: sim ``Vrf`` + per-zone ``VlanGroup`` rows → SQL.

Admin IPAM UI needs at least one VRF and VLAN group to exercise list/create/edit
flows against the hermetic stack. One org-scoped VRF is shared by every zone;
each zone gets its own VLAN group. Existing ``Prefix`` rows from ``46-prefixes``
are attached to the VRF so relation counts are non-zero. Numbering: 47 > 46."""

from __future__ import annotations

import uuid
from pathlib import Path

import yaml
from local.config import get_settings
from local.derived import LOCAL_NS
from local.sqlemit import header, logs_to_stderr, q
from local.zones import zone_uuid

_VRF_NAME = "sim-vrf"
_VRF_RD = "65000:1"


def _vrf_uuid(org_id: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"vrf:{org_id}:default"))


def _vlan_group_uuid(zone_id: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"vlan-group:{zone_id}"))


def _vrf_sql(vrf_id: str, org_id: str) -> str:
    return f"""-- org-scoped VRF for admin IPAM / prefix association
INSERT INTO "Vrf" (id, name, rd, description, "organizationId", "createdAt", "updatedAt")
VALUES (
    {q(vrf_id)}, {q(_VRF_NAME)}, {q(_VRF_RD)},
    'Sim default VRF (seeded for admin IPAM)',
    {q(org_id)}, NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    rd = EXCLUDED.rd,
    description = EXCLUDED.description,
    "organizationId" = EXCLUDED."organizationId",
    "deletedAt" = NULL,
    "updatedAt" = NOW();
"""


def _vlan_group_sql(group_id: str, zone_id: str, zone_name: str) -> str:
    name = f"{zone_name}-vlans"
    return f"""-- VLAN group for zone {zone_id} ({zone_name})
INSERT INTO "VlanGroup" (id, name, description, "minVid", "maxVid", "zoneId", "createdAt", "updatedAt")
VALUES (
    {q(group_id)}, {q(name)},
    {q(f"Sim VLAN group for {zone_name}")},
    2, 4094, {q(zone_id)}, NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    "minVid" = EXCLUDED."minVid",
    "maxVid" = EXCLUDED."maxVid",
    "zoneId" = EXCLUDED."zoneId",
    "updatedAt" = NOW();
"""


def _attach_prefixes_sql(vrf_id: str, org_id: str) -> str:
    return f"""-- attach org prefixes to the sim VRF (counts show up in admin VRF list)
UPDATE "Prefix"
SET "vrfId" = {q(vrf_id)}, "updatedAt" = NOW()
WHERE "organizationId" = {q(org_id)}
  AND "deletedAt" IS NULL
  AND ("vrfId" IS NULL OR "vrfId" = {q(vrf_id)});
"""


def _attach_gateways_sql(org_id: str) -> str:
    """Carry each gateway into its prefix's VRF.

    Load-bearing, not cosmetic: the hub's netplan planner resolves a device's route VRF as
    ``ip.vrfId ?? prefix.vrfId`` and then matches ``gateway.vrfId`` against it. Sim device IPs carry
    no VRF, so once the sweep above puts a prefix in the sim VRF, a NULL-VRF gateway on that prefix
    can never match and the device renders with no default route. Runs after the prefix sweep.
    """
    return f"""-- gateways follow their prefix into the VRF (netplan matches gateway.vrfId against it)
UPDATE "Gateway" g
SET "vrfId" = p."vrfId", "updatedAt" = NOW()
FROM "Prefix" p
WHERE p.id = g."prefixId"
  AND p."organizationId" = {q(org_id)}
  AND p."deletedAt" IS NULL
  AND g."vrfId" IS DISTINCT FROM p."vrfId";
"""


def generate() -> str:
    s = get_settings()
    org_id = s.sim.hydrahost_org_id
    fleet = yaml.safe_load(Path(s.paths.fleet_path).read_text())
    zones_meta = fleet.get("zones") or [{"index": 0, "name": s.sim.zone_name}]

    vrf_id = _vrf_uuid(org_id)
    out: list[str] = [header("47-vrfs-vlan-groups.py"), "BEGIN;\n\n"]
    out.append(_vrf_sql(vrf_id, org_id))
    out.append("\n")
    for z in sorted(zones_meta, key=lambda zz: zz["index"]):
        zid = zone_uuid(z["index"])
        out.append(_vlan_group_sql(_vlan_group_uuid(zid), zid, z["name"]))
    out.append("\n")
    out.append(_attach_prefixes_sql(vrf_id, org_id))
    out.append(_attach_gateways_sql(org_id))
    out.append("COMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
