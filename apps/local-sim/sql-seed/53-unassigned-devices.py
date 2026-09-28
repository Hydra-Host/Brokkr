#!/usr/bin/env python
"""Two PLANNED role=NULL Device rows for adminListDevices?role=unassigned pickers.
uuid5-stable IDs; re-seed only refreshes while role is still NULL.
"""

from __future__ import annotations

import uuid

from local.config import get_settings
from local.sqlemit import header, logs_to_stderr, q
from local.zones import zone_uuid

# Distinct from 55-dcim's namespace so labels never collide across generators.
_NS = uuid.UUID("53a5519e-0000-4000-8000-000000000000")

UNASSIGNED = (
    ("unassigned-1", "device:unassigned-1"),
    ("unassigned-2", "device:unassigned-2"),
)


def device_id(label: str) -> str:
    return str(uuid.uuid5(_NS, label))


def generate() -> str:
    s = get_settings()
    org_id = s.sim.hydrahost_org_id
    zone_id = zone_uuid(0)
    host_arch = s.sim.host_arch

    out: list[str] = [header("53-unassigned-devices.py"), "BEGIN;\n"]

    for name, label in UNASSIGNED:
        did = device_id(label)
        out.append(f"-- {name} id={did} (role=null, PLANNED — admin Create Switch/Server picker)")
        out.append(
            f"""INSERT INTO "Device" (
    id, name, status, role,
    "zoneId", "networkType",
    "supplierId",
    architecture, "updatedAt"
) VALUES (
    {q(did)}, {q(name)}, 'PLANNED'::"DeviceStatus", NULL,
    {q(zone_id)}, 'Public'::"DeviceNetworkType",
    {q(org_id)},
    {q(host_arch)}, NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    status = EXCLUDED.status,
    role = EXCLUDED.role,
    "zoneId" = EXCLUDED."zoneId",
    "networkType" = EXCLUDED."networkType",
    "supplierId" = EXCLUDED."supplierId",
    architecture = EXCLUDED.architecture,
    "updatedAt" = NOW()
WHERE "Device".role IS NULL;"""
        )
        out.append("")

    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
