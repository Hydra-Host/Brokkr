#!/usr/bin/env python
"""Generator: per-VM Hub Postgres device state → idempotent SQL (Device/Server/storage/netplan/SOL/interfaces).

Every value derives from the same pure functions the Python seed uses; supplier/org resolve at apply-time
via subqueries against the ``Zone`` row (seeded by ``45-zone``)."""

from __future__ import annotations

import ipaddress
import uuid

from local.config import get_settings
from local.derived import effective_bmc_ip, effective_node_ip, node_serial, node_wwn, sim_device_uuid
from local.schema import require_fleet
from local.seed.interfaces import (
    DATA_NIC,
    IPMI_NIC,
    emit_device_name_clear,
    emit_device_zone_move_prep,
    emit_ip_on_interface,
    emit_role_trigger,
)
from local.seed.netplan import sim_dhcp_netplan, sim_static_netplan
from local.seed.storage import build_storage_layouts
from local.seed.tags import emit_tag, emit_tag_assign
from local.sqlemit import header, logs_to_stderr, q, qj
from local.zones import zone_uuid


def _gateway_ip(data_cidr: str) -> str:
    return str(ipaddress.ip_network(data_cidr, strict=False).network_address + 1)


# RFC 5737 TEST-NET-2 — public "outside" addresses for NATed sim devices. Without a mapped
# outside address the DCIM list renders blank (a NAT device shows its public IP, not the private one).
NAT_PUBLIC_CIDR = "198.51.100.0/24"

# The bridge boots the light brokkr-live image for a device tagged discovery-light; a simulated
# VM cannot boot the full image, so the seed tags every VM.
DISCOVERY_LIGHT_TAG = "discovery-light"
DISCOVERY_LIGHT_TAG_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "brokkr-sim:platform-tag:discovery-light"))


def generate() -> str:
    s = get_settings()
    host_arch = s.sim.host_arch
    # SOL port for the guest serial console: arm64 `virt` has only PL011 → ttyAMA0, x86_64 q35 has
    # an ISA COM port → ttyS0. A wrong value points console= at a nonexistent UART and boot goes dark.
    sol_port = "ttyAMA0" if host_arch == "arm64" else "ttyS0"

    fleet = require_fleet()
    if not fleet.has_vm:
        return header("50-devices.py") + "-- no VM nodes: sim VM devices are not seeded.\n"
    network = fleet.network
    gateway = _gateway_ip(network.cidr)
    data_prefixlen = ipaddress.ip_network(network.cidr, strict=False).prefixlen
    cpu_count = fleet.defaults.cpus
    memory_mb = fleet.defaults.memory_mb
    # Cpu.architecture is a free string; keep it aligned with Device.architecture.
    cpu_arch = "aarch64" if host_arch == "arm64" else "x86_64"
    cpu_model = "QEMU Virtual CPU" if host_arch != "arm64" else "QEMU Virtual aarch64 CPU"

    out: list[str] = [
        header("50-devices.py"),
        "BEGIN;\n",
        emit_role_trigger(on=False),
        emit_tag(DISCOVERY_LIGHT_TAG_ID, DISCOVERY_LIGHT_TAG, DISCOVERY_LIGHT_TAG, "#38bdf8", s.sim.hydrahost_org_id),
    ]

    for i, n in enumerate(fleet.nodes):
        if not n.seed_as_server:
            continue
        device_id = sim_device_uuid(i)
        # Identity (device UUID, IPs) stays keyed on flat list position `i`; the zone is metadata
        # from the node's `zone` field. supplier/org come from that zone's row (45-zone) via subqueries.
        zone_id = zone_uuid(fleet.zone_for(n.zone).index)
        sup = f'(SELECT "organizationId" FROM "Zone" WHERE id = {q(zone_id)})'
        org = sup
        name = n.name
        ipmi = effective_bmc_ip(n, network.bmc_cidr, i)
        primary = effective_node_ip(n, network.cidr, i)
        layouts = build_storage_layouts(n.ipmi_mac, n.disk_gb)
        # DHCP mode: the guest learns its address from the DHCP reservation (the eth0 IpAddress
        # seeded below), so the netplan override carries dhcp4 instead of the static IP.
        # rendered_netplan mode: no override at all, so the hub's renderer runs (see Network schema).
        netplan = (
            None
            if network.rendered_netplan
            else sim_dhcp_netplan(n.data_mac)
            if network.dhcp
            else sim_static_netplan(primary, gateway, n.data_mac, prefix=data_prefixlen)
        )
        size_bytes = n.disk_gb * 1024 * 1024 * 1024
        # Sim data-plane IPs are host-reachable, so devices default to flat (Public). A node can opt
        # into NAT via `network_type: nat` in fleet.yml to exercise the NAT-aware display path.
        network_type = "NAT" if n.network_type == "nat" else "Public"
        public_ip = str(ipaddress.ip_network(NAT_PUBLIC_CIDR).network_address + 10 + i)
        serial = node_serial(n.ipmi_mac)

        out.append(
            f"-- {name} id={device_id} ipmi={ipmi} primary={primary} net={network_type} arch={host_arch} zone={zone_id}"
        )
        out.append(emit_device_name_clear(device_id, zone_id, name, org))
        out.append(emit_device_zone_move_prep(device_id, zone_id))
        out.append(
            f"""INSERT INTO "Device" (
    id, name, status, role,
    serial, "systemSerial", "chassisSerial", "baseboardSerial",
    "zoneId", "networkType",
    "supplierId",
    architecture, "updatedAt"
) VALUES (
    {q(device_id)}, {q(name)}, 'ACTIVE'::"DeviceStatus", 'Server'::"DeviceRole",
    {q(serial)}, {q(serial)}, {q(serial)}, {q(serial)},
    {q(zone_id)}, {q(network_type)}::"DeviceNetworkType",
    {sup},
    {q(host_arch)}, NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, status = EXCLUDED.status, role = EXCLUDED.role,
    serial = EXCLUDED.serial,
    "systemSerial" = EXCLUDED."systemSerial", "chassisSerial" = EXCLUDED."chassisSerial",
    "baseboardSerial" = EXCLUDED."baseboardSerial",
    "zoneId" = EXCLUDED."zoneId", "networkType" = EXCLUDED."networkType",
    "supplierId" = EXCLUDED."supplierId",
    architecture = EXCLUDED.architecture,
    "deletedAt" = NULL, "updatedAt" = NOW();"""
        )
        out.append(
            f"""INSERT INTO "Server" (id, "deviceId", "powerStatus", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), {q(device_id)}, 'On'::"ServerPowerStatus", NOW(), NOW())
ON CONFLICT ("deviceId") DO NOTHING;"""
        )
        out.append(
            f"""UPDATE "Server" SET "powerStatus" = 'On'::"ServerPowerStatus", "updatedAt" = NOW()
WHERE "deviceId" = {q(device_id)};"""
        )
        out.append(
            f"""UPDATE "Server" SET "storageLayouts" = {qj(layouts)}, "updatedAt" = NOW()
WHERE "deviceId" = {q(device_id)};"""
        )
        out.append(
            f"""UPDATE "Server" SET "netplanOverride" = {q(netplan)}, "updatedAt" = NOW()
WHERE "deviceId" = {q(device_id)};"""
        )
        out.append(f'DELETE FROM "StorageDrive" WHERE "deviceId" = {q(device_id)};')
        out.append(
            f"""INSERT INTO "StorageDrive" (id, name, type, serial, wwn, "sizeBytes", "deviceId", "updatedAt")
VALUES (gen_random_uuid(), 'sda', 'SSD'::"StorageDriveType",
    {q(serial)}, {q(node_wwn(n.ipmi_mac))}, {size_bytes}, {q(device_id)}, NOW());"""
        )
        # Hardware inventory for admin Hardware tab (CPU / memory / firmware / GPU).
        # Derived from fleet defaults so sizes stay coherent with the qemu domain.
        out.append(f'DELETE FROM "Cpu" WHERE "deviceId" = {q(device_id)};')
        for socket in range(cpu_count):
            out.append(
                f"""INSERT INTO "Cpu" (
    id, "socketIndex", model, vendor, architecture,
    "coreCount", "threadCount", capabilities, "deviceId", "updatedAt"
) VALUES (
    gen_random_uuid(), {socket}, {q(cpu_model)}, 'QEMU', {q(cpu_arch)},
    2, 2, ARRAY[]::text[], {q(device_id)}, NOW()
)
ON CONFLICT ("deviceId", "socketIndex") DO UPDATE SET
    model = EXCLUDED.model, vendor = EXCLUDED.vendor, architecture = EXCLUDED.architecture,
    "coreCount" = EXCLUDED."coreCount", "threadCount" = EXCLUDED."threadCount",
    "updatedAt" = NOW();"""
            )
        dimm_summary = f"1x{memory_mb // 1024}GB DDR4 3200 MT/s" if memory_mb >= 1024 else f"1x{memory_mb}MB DDR4"
        out.append(
            f"""INSERT INTO "MemoryConfig" (
    id, "totalSizeMb", "populatedDimms", "totalSlots",
    "dimmSizeMb", "dimmType", "dimmSpeed", "configuredSpeed",
    "eccType", "configSummary", "deviceId", "updatedAt"
) VALUES (
    gen_random_uuid(), {memory_mb}, 1, 4,
    {memory_mb}, 'DDR4'::"MemoryType", '3200 MT/s', '3200 MT/s',
    'NONE'::"MemoryEccType", {q(dimm_summary)}, {q(device_id)}, NOW()
)
ON CONFLICT ("deviceId") DO UPDATE SET
    "totalSizeMb" = EXCLUDED."totalSizeMb",
    "populatedDimms" = EXCLUDED."populatedDimms",
    "totalSlots" = EXCLUDED."totalSlots",
    "dimmSizeMb" = EXCLUDED."dimmSizeMb",
    "dimmType" = EXCLUDED."dimmType",
    "dimmSpeed" = EXCLUDED."dimmSpeed",
    "configuredSpeed" = EXCLUDED."configuredSpeed",
    "eccType" = EXCLUDED."eccType",
    "configSummary" = EXCLUDED."configSummary",
    "updatedAt" = NOW();"""
        )
        out.append(
            f"""INSERT INTO "DeviceFirmware" (id, type, vendor, version, date, "deviceId", "updatedAt")
VALUES
    (gen_random_uuid(), 'BIOS'::"FirmwareType", 'EDK2', 'sim-1.0', NULL, {q(device_id)}, NOW()),
    (gen_random_uuid(), 'BMC'::"FirmwareType", 'OpenIPMI', 'sim-1.0', NULL, {q(device_id)}, NOW())
ON CONFLICT ("deviceId", type) DO UPDATE SET
    vendor = EXCLUDED.vendor, version = EXCLUDED.version, "updatedAt" = NOW();"""
        )
        # One synthetic GPU so the Hardware GPUs table is exercisable on every sim server.
        out.append(
            f"""INSERT INTO "Gpu" (
    id, index, model, vendor, serial, "memoryTotalMb",
    "eccEnabled", "pcieLinkGen", "pcieLinkWidth", "vbiosVersion",
    "deviceId", "updatedAt"
) VALUES (
    gen_random_uuid(), 0, 'NVIDIA GeForce RTX 4090', 'NVIDIA'::"GpuVendor",
    {q(f"SIM-GPU-{i + 1:04d}")}, 24576,
    false, 4, 16, 'sim-vbios-1.0',
    {q(device_id)}, NOW()
)
ON CONFLICT ("deviceId", index) DO UPDATE SET
    model = EXCLUDED.model, vendor = EXCLUDED.vendor, serial = EXCLUDED.serial,
    "memoryTotalMb" = EXCLUDED."memoryTotalMb",
    "eccEnabled" = EXCLUDED."eccEnabled",
    "pcieLinkGen" = EXCLUDED."pcieLinkGen", "pcieLinkWidth" = EXCLUDED."pcieLinkWidth",
    "vbiosVersion" = EXCLUDED."vbiosVersion",
    "updatedAt" = NOW();"""
        )
        # SOL/serial console: the hub derives serial_port_recommended (which gates console=<port> in the
        # discovery iPXE cmdline) from this DeviceSolConfig row. Without it, boot output stays dark.
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
        out.append(
            f"""INSERT INTO "Interface"
    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description,
     speed, mtu, "linkType", driver, operstate, "linkOperUp", "linkPhysicalUp", "markConnected", "updatedAt")
VALUES (gen_random_uuid(), 'eth0', 'ETHERNET_1G'::"InterfaceType", true,
    {q(n.data_mac)}, false, {q(device_id)}, 'Primary data NIC',
    1000, 1500, 'ETHERNET'::"InterfaceLinkType", 'virtio_net', 'up', true, true, true, NOW())
ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET
    type = EXCLUDED.type, "macAddress" = EXCLUDED."macAddress",
    "mgmtOnly" = EXCLUDED."mgmtOnly", description = EXCLUDED.description,
    speed = EXCLUDED.speed, mtu = EXCLUDED.mtu, "linkType" = EXCLUDED."linkType",
    driver = EXCLUDED.driver, operstate = EXCLUDED.operstate,
    "linkOperUp" = EXCLUDED."linkOperUp", "linkPhysicalUp" = EXCLUDED."linkPhysicalUp",
    "markConnected" = EXCLUDED."markConnected", "updatedAt" = NOW();"""
        )
        out.append(
            f"""INSERT INTO "Interface"
    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description,
     speed, mtu, driver, operstate, "linkOperUp", "linkPhysicalUp", "markConnected", "updatedAt")
VALUES (gen_random_uuid(), 'IPMI', 'IPMI_BMC'::"InterfaceType", true,
    {q(n.ipmi_mac)}, true, {q(device_id)}, 'BMC management interface',
    100, 1500, 'ipmi_si', 'up', true, true, true, NOW())
ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET
    type = EXCLUDED.type, "macAddress" = EXCLUDED."macAddress",
    "mgmtOnly" = EXCLUDED."mgmtOnly", description = EXCLUDED.description,
    speed = EXCLUDED.speed, mtu = EXCLUDED.mtu, driver = EXCLUDED.driver,
    operstate = EXCLUDED.operstate, "linkOperUp" = EXCLUDED."linkOperUp",
    "linkPhysicalUp" = EXCLUDED."linkPhysicalUp", "markConnected" = EXCLUDED."markConnected",
    "updatedAt" = NOW();"""
        )
        # Synthetic InfiniBand port so the admin Interfaces IB table is non-empty.
        ib_guid = f"0x{n.ipmi_mac.replace(':', '')}0000"
        out.append(
            f"""INSERT INTO "Interface"
    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description,
     "linkType", guid, "maxSpeedGbps", mtu, "portState",
     driver, operstate, "linkOperUp", "linkPhysicalUp", "markConnected", "updatedAt")
VALUES (gen_random_uuid(), 'ib0', 'INFINIBAND_HDR'::"InterfaceType", true,
    NULL, false, {q(device_id)}, 'Sim InfiniBand / RDMA port',
    'INFINIBAND'::"InterfaceLinkType", {q(ib_guid)}, 200, 4092, 'ACTIVE',
    'mlx5_ib', 'up', true, true, true, NOW())
ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET
    type = EXCLUDED.type, "mgmtOnly" = EXCLUDED."mgmtOnly", description = EXCLUDED.description,
    "linkType" = EXCLUDED."linkType", guid = EXCLUDED.guid, "maxSpeedGbps" = EXCLUDED."maxSpeedGbps",
    mtu = EXCLUDED.mtu, "portState" = EXCLUDED."portState",
    driver = EXCLUDED.driver, operstate = EXCLUDED.operstate,
    "linkOperUp" = EXCLUDED."linkOperUp", "linkPhysicalUp" = EXCLUDED."linkPhysicalUp",
    "markConnected" = EXCLUDED."markConnected", "updatedAt" = NOW();"""
        )
        out.append(emit_tag_assign(DISCOVERY_LIGHT_TAG_ID, "DEVICE", q(device_id)))
        out.extend(emit_ip_on_interface(device_id, IPMI_NIC, ipmi, org))
        # The device's reachable IPv4 comes from the first IpAddress on a non-mgmtOnly interface
        # (DeviceSpecHelper.firstDataIp), not the decommissioned Device.primaryIp4 scalar. Attach it to eth0.
        out.extend(emit_ip_on_interface(device_id, DATA_NIC, f"{primary}/{data_prefixlen}", org))
        # NAT outside address: an unattached public IpAddress whose natInsideId points at the eth0
        # private IP. Recreated AFTER the eth0 IP above so the natInsideId subquery resolves to the fresh id.
        out.append(
            f"""DELETE FROM "IpAddress"
WHERE address = {q(f"{public_ip}/32")}::inet AND "organizationId" = {org};"""
        )
        if network_type == "NAT":
            out.append(
                f"""INSERT INTO "IpAddress" (id, address, status, "organizationId", "natInsideId", "updatedAt")
SELECT gen_random_uuid(), {q(f"{public_ip}/32")}::inet, 'ACTIVE'::"IpStatus", {org}, a.id, NOW()
FROM "IpAddress" a
    JOIN "Interface" i ON i.id = a."interfaceId"
WHERE i."deviceId" = {q(device_id)} AND i.name = 'eth0' AND i."deletedAt" IS NULL
LIMIT 1;"""
            )
        out.append("")

    out.append(emit_role_trigger(on=True))
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
