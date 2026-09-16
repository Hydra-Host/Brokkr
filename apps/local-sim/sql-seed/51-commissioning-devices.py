#!/usr/bin/env python
"""Generator: seed_as_server=false nodes → role=NULL commissioning devices (IPMI-only, DHCP, no static)."""

from __future__ import annotations

from local.config import get_settings
from local.derived import effective_bmc_ip, sim_device_uuid
from local.schema import require_fleet
from local.seed.interfaces import (
    DATA_NIC,
    IPMI_NIC,
    emit_device_name_clear,
    emit_device_zone_move_prep,
    emit_interface,
    emit_ip_delete,
    emit_ip_on_interface,
    emit_role_trigger,
)
from local.sqlemit import header, logs_to_stderr, q
from local.zones import zone_uuid


def generate() -> str:
    s = get_settings()
    host_arch = s.sim.host_arch
    sol_port = "ttyAMA0" if host_arch == "arm64" else "ttyS0"

    fleet = require_fleet()
    bmc_cidr = fleet.network.bmc_cidr

    # Bracket the write-once trigger only when this generator has a device to write: an empty run
    # would take ACCESS EXCLUSIVE on Device for nothing.
    has_commissioning = any(not n.seed_as_server for n in fleet.nodes)

    out: list[str] = [header("51-commissioning-devices.py"), "BEGIN;\n"]
    if has_commissioning:
        out.append(emit_role_trigger(on=False))

    for i, n in enumerate(fleet.nodes):
        if n.seed_as_server:
            continue
        device_id = sim_device_uuid(i)
        zone_id = zone_uuid(fleet.zone_for(n.zone).index)
        org = f'(SELECT "organizationId" FROM "Zone" WHERE id = {q(zone_id)})'
        name = n.name
        ipmi = effective_bmc_ip(n, bmc_cidr, i)

        out.append(f"-- {name} id={device_id} (role=null commissioning, dhcp) ipmi={ipmi}")
        out.append(emit_device_name_clear(device_id, zone_id, name, org))
        out.append(emit_device_zone_move_prep(device_id, zone_id))
        out.append(
            f"""INSERT INTO "Device" (
    id, name, status, role, "deviceType",
    "zoneId", "networkType",
    "supplierId",
    architecture, "netplanOverride", "updatedAt"
) VALUES (
    {q(device_id)}, {q(name)}, 'PLANNED'::"DeviceStatus", NULL, 'Baremetal'::"DeviceType",
    {q(zone_id)}, 'Public'::"DeviceNetworkType",
    {org},
    {q(host_arch)}, NULL, NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, status = EXCLUDED.status, role = EXCLUDED.role,
    "deviceType" = EXCLUDED."deviceType",
    "zoneId" = EXCLUDED."zoneId", "networkType" = EXCLUDED."networkType",
    "supplierId" = EXCLUDED."supplierId",
    architecture = EXCLUDED.architecture, "netplanOverride" = NULL,
    "deletedAt" = NULL, "updatedAt" = NOW();"""
        )
        out.append(
            f"""DO $$ BEGIN
    IF to_regclass('"ServerOperatingSystem"') IS NOT NULL THEN
        DELETE FROM "ServerOperatingSystem" WHERE "serverId" IN
            (SELECT id FROM "Server" WHERE "deviceId" = {q(device_id)});
    END IF;
END $$;"""
        )
        out.append(f'DELETE FROM "StorageDrive" WHERE "deviceId" = {q(device_id)};')
        out.append(f'DELETE FROM "Server" WHERE "deviceId" = {q(device_id)};')
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
        out.append(emit_interface(device_id, DATA_NIC, n.data_mac))
        # eth0 is seeded MAC-only: an commissioning device has no assigned address until it is claimed.
        out.append(emit_ip_delete(device_id, DATA_NIC))
        out.append(emit_interface(device_id, IPMI_NIC, n.ipmi_mac))
        out.extend(emit_ip_on_interface(device_id, IPMI_NIC, ipmi, org))
        out.append("")

    if has_commissioning:
        out.append(emit_role_trigger(on=True))
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
