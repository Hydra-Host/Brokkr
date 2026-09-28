#!/usr/bin/env python
from __future__ import annotations

from local.derived import bm_device_uuid
from local.schema import require_fleet
from local.seed.interfaces import emit_device_name_clear
from local.sqlemit import header, logs_to_stderr, q
from local.zones import zone_uuid


def generate() -> str:
    fleet = require_fleet()

    if not fleet.has_bm:
        return header("52-baremetal-devices.py") + "-- no bare-metal machines: no bare-metal devices to seed.\n"

    # Bare-metal devices land in zone 0 regardless of a node's declared zone (the zone-per-node
    # split is only wired for the VM roster).
    zone_id = zone_uuid(0)
    sup = f'(SELECT "organizationId" FROM "Zone" WHERE id = {q(zone_id)})'
    org = sup

    out: list[str] = [header("52-baremetal-devices.py"), "BEGIN;\n"]

    for n in fleet.bm_nodes:
        name = n.name
        pxe_mac = n.pxe_mac
        bmc_mac = n.bmc_mac
        bmc_ip = n.bmc_ip
        arch = n.arch
        network_type = "NAT" if n.network_type == "nat" else "Public"
        device_id = bm_device_uuid(pxe_mac)
        sol_port = "ttyAMA0" if arch == "arm64" else "ttyS0"

        out.append(f"-- {name} id={device_id} pxe={pxe_mac} bmc={bmc_ip} net={network_type} arch={arch} zone={zone_id}")
        out.append(emit_device_name_clear(device_id, zone_id, name, org))
        out.append(
            f"""INSERT INTO "Device" (
    id, name, status, role,
    "zoneId", "networkType",
    "supplierId",
    architecture, "updatedAt"
) VALUES (
    {q(device_id)}, {q(name)}, 'ACTIVE'::"DeviceStatus", 'Server'::"DeviceRole",
    {q(zone_id)}, {q(network_type)}::"DeviceNetworkType",
    {sup},
    {q(arch)}, NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    "zoneId" = EXCLUDED."zoneId", "networkType" = EXCLUDED."networkType",
    "supplierId" = EXCLUDED."supplierId",
    architecture = EXCLUDED.architecture,
    "updatedAt" = NOW();"""
        )
        out.append(
            f"""INSERT INTO "Server" (id, "deviceId", "powerStatus", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), {q(device_id)}, 'On'::"ServerPowerStatus", NOW(), NOW())
ON CONFLICT ("deviceId") DO NOTHING;"""
        )
        out.append(
            f"""INSERT INTO "DeviceSolConfig" (
    "deviceId", "solCapable", "solEnabled", "baudRate", "optimalPort", "availablePorts", "updatedAt"
) VALUES (
    {q(device_id)}, true, true, 115200, {q(sol_port)}, ARRAY[{q(sol_port)}]::text[], NOW()
)
ON CONFLICT ("deviceId") DO UPDATE SET
    "solCapable" = EXCLUDED."solCapable", "solEnabled" = EXCLUDED."solEnabled",
    "baudRate" = EXCLUDED."baudRate", "optimalPort" = EXCLUDED."optimalPort",
    "availablePorts" = EXCLUDED."availablePorts", "updatedAt" = NOW();"""
        )
        # the data NIC is keyed on its MAC, not its name: discovery (or an operator) may rename the
        # row, and no unique index on the MAC exists yet, so two statements stand in for an upsert.
        pxe_row = f'"deviceId" = {q(device_id)} AND lower("macAddress") = {q(pxe_mac)} AND "deletedAt" IS NULL'
        out.append(
            f"""UPDATE "Interface" SET
    type = 'ETHERNET_1G'::"InterfaceType", enabled = true, "mgmtOnly" = false,
    description = 'Primary data NIC (PXE)', "updatedAt" = NOW()
WHERE {pxe_row};"""
        )
        out.append(
            f"""INSERT INTO "Interface"
    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description, "updatedAt")
SELECT gen_random_uuid(), 'eth0', 'ETHERNET_1G'::"InterfaceType", true,
    {q(pxe_mac)}, false, {q(device_id)}, 'Primary data NIC (PXE)', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Interface" WHERE {pxe_row});"""
        )
        out.append(
            f"""INSERT INTO "Interface"
    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description, "updatedAt")
VALUES (gen_random_uuid(), 'IPMI', 'IPMI_BMC'::"InterfaceType", true,
    {q(bmc_mac)}, true, {q(device_id)}, 'BMC management interface', NOW())
ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET
    type = EXCLUDED.type, "macAddress" = EXCLUDED."macAddress",
    "mgmtOnly" = EXCLUDED."mgmtOnly", "updatedAt" = NOW();"""
        )
        out.append(
            f"""DELETE FROM "IpAddress"
WHERE "organizationId" = {org} AND address = {q(bmc_ip)}::inet;"""
        )
        out.append(
            f"""INSERT INTO "IpAddress"
    (id, address, status, "organizationId", "interfaceId", "assignedObjectType", "assignedObjectId", "updatedAt")
SELECT gen_random_uuid(), {q(bmc_ip)}::inet, 'ACTIVE'::"IpStatus", {org},
    id, 'Interface'::"AssignedObjectType", id, NOW()
FROM "Interface" WHERE "deviceId" = {q(device_id)} AND name = 'IPMI';"""
        )
        out.append("")

    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
