#!/usr/bin/env python
"""Generator: DCIM / Circuits / BGP / Tags test data for the sim fleet → SQL.

Decorates the per-VM servers (seeded by ``50-devices``) with a complete slice of infrastructure (racks, peer
devices, ports, cables, tags, ASNs/sessions, a circuit) so the DCIM/Circuits/BGP/Tags pages render real data.
Every row gets a deterministic uuid5 id (fully idempotent); numbered 55 (after ``50-devices``, before
``60-listing``)."""

from __future__ import annotations

import re
import uuid

from local.config import get_settings
from local.derived import sim_device_uuid
from local.schema import require_fleet
from local.sqlemit import emit_upsert, header, logs_to_stderr, q, qe
from local.zones import zone_uuid

# Fixed namespace so uuid5 ids are stable across re-runs (no randomness — see module docstring).
_NS = uuid.UUID("5e0d1c00-0000-4000-8000-000000000000")


def did(label: str) -> str:
    """Deterministic id for a row this generator owns, keyed by a semantic label."""
    return str(uuid.uuid5(_NS, label))


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


# ── catalog data (kept inline; not derived from fleet.yml) ──────────────────────
MANUFACTURERS = ["Brokkr", "NVIDIA", "Eaton", "Opengear", "Generic", "Motivair", "Juniper"]

# (manufacturer, name, title, email, phone, notes, ticketing portal, website)
MANUFACTURER_CONTACTS = [
    (
        "NVIDIA",
        "Taylor Example",
        "Technical Support Engineer",
        "nvidia-support@example.test",
        "+12025550120",
        "Local simulator technical support contact.",
        "https://support.example.test/nvidia",
        "https://nvidia.example.test",
    ),
    (
        "Eaton",
        "Jordan Example",
        "Account Manager",
        "eaton-sales@example.test",
        "+12025550121",
        "Local simulator sales contact.",
        None,
        "https://eaton.example.test",
    ),
]

# (manufacturer, model, formFactor, heightU, maxPowerW, description)
MODELS = [
    ("Brokkr", "Sim Virtual Server", "2U", 2, 800, "Simulated bare-metal server (qemu)"),
    ("NVIDIA", "SN2201", "1U", 1, 150, "48-port 1GbE management / ToR switch"),
    ("Eaton", "9001-22313", "0U", 0, 17000, "Rack-mount PDU, 24x C13 outlets"),
    ("Opengear", "IM7248", "1U", 1, 30, "48-port serial console server (OOB)"),
    ("Generic", "LC-24 Patch Panel", "1U", 1, None, "24-port LC fiber patch panel"),
    ("Generic", "Cat6A-48 Patch Panel", "1U", 1, None, "48-port Cat6A copper patch panel"),
    ("Motivair", "ChilledDoor CDU-40", "0U", 0, 2000, "Rack-mount coolant distribution unit, 40kW"),
    ("Juniper", "MX204", "1U", 1, 400, "Compact edge/aggregation router"),
    ("Generic", "1U Cable Brush Panel", "1U", 1, None, "1U rack cable-management brush panel"),
]
SERVER_MODEL = ("Brokkr", "Sim Virtual Server")

# (name, slug, color)
RACK_ROLES = [
    ("Compute", "compute", "3b82f6"),
    ("Network", "network", "06b6d4"),
    ("Power", "power", "64748b"),
]

RACK_NAME = "SIM-R1"
RACK_ID = did(f"rack:{RACK_NAME}")
RACK_HEIGHT_U = 42  # shared by the Rack row + peer top-of-rack placement (must stay in sync)

# peer infra mounted alongside the servers (deviceName, manufacturer, model).
SWITCH = "sim-tor-1"
PDU = "sim-pdu-1"
CONSERVER = "sim-conserver-1"
PATCH = "sim-patch-1"
PEERS = [
    (SWITCH, "NVIDIA", "SN2201"),
    (PDU, "Eaton", "9001-22313"),
    (CONSERVER, "Opengear", "IM7248"),
    (PATCH, "Generic", "LC-24 Patch Panel"),
]

# Per-role facility devices (own DeviceRole + MTI child row) → per-role DCIM pages; distinct from PEERS above.
# (name, manufacturer, model, outletCount, ratedAmperage, voltageType, powerStatus)
ROLE_PDUS = [
    ("sim-pdu-a", "Eaton", "9001-22313", 24, 30, "208V", "On"),
    ("sim-pdu-b", "Eaton", "9001-22313", 42, 60, "415V", "Off"),
]

# (name, manufacturer, model, coolantType, ratedFlowRateLpm, ratedThermalCapacityKw, airflow, powerStatus)
ROLE_CDUS = [
    ("sim-cdu-a", "Motivair", "ChilledDoor CDU-40", "water", 120.0, 300, "FrontToRear", "On"),
    ("sim-cdu-b", "Motivair", "ChilledDoor CDU-40", "glycol", 90.5, 200, "RearToFront", "Off"),
]

# (name, manufacturer, model, switchRole, fabric, portCount, powerStatus)
ROLE_SWITCHES = [
    ("sim-switch-a", "NVIDIA", "SN2201", "leaf", "east-west", 48, "On"),
    ("sim-switch-b", "NVIDIA", "SN2201", "spine", "north-south", 48, "Off"),
]

# (name, manufacturer, model, routerType, bgpAsn, powerStatus)
ROLE_ROUTERS = [
    ("sim-router-a", "Juniper", "MX204", "edge", 64512, "On"),
    ("sim-router-b", "Juniper", "MX204", "border", 64513, "Off"),
]

# (name, manufacturer, model, brushMaterial, rackUnitHeight) — passive hardware, no powerStatus.
ROLE_RACK_BRUSHES = [
    ("sim-rackbrush-a", "Generic", "1U Cable Brush Panel", "nylon", 1),
    ("sim-rackbrush-b", "Generic", "1U Cable Brush Panel", "polypropylene", 1),
]

# (name, manufacturer, model, panelType, portCount, rackUnitHeight) — passive hardware, no powerStatus.
ROLE_PATCH_PANELS = [
    ("sim-patchpanel-a", "Generic", "LC-24 Patch Panel", "fiber", 24, 1),
    ("sim-patchpanel-b", "Generic", "Cat6A-48 Patch Panel", "copper", 48, 1),
]

# (name, color) — org-scoped tags.
TAGS = [
    ("Compute", "3b82f6"),
    ("Managed", "10b981"),
    ("Networking", "06b6d4"),
    ("Power", "64748b"),
    ("OOB", "78716c"),
]


_BGP_SESSION_COLS = "id name status deviceId localAsnId remoteAsnId peerGroupId prefixListOutId"
_BGP_SESSION_UPDATE = "status deviceId localAsnId remoteAsnId peerGroupId prefixListOutId"


def _model_ref(mfr: str, model: str) -> str:
    return f'(SELECT id FROM "DeviceModel" WHERE manufacturer = {q(mfr)} AND model = {q(model)})'


def _eth0_ref(i: int) -> str:
    """terminationId for a server's primary NIC (50-devices minted its id randomly)."""
    return (
        f'(SELECT id FROM "Interface" WHERE "deviceId" = {q(sim_device_uuid(i))} '
        f"AND name = 'eth0' AND \"deletedAt\" IS NULL)"
    )


def _eth0_ip_ref(i: int) -> str:
    return (
        f'(SELECT a.id FROM "IpAddress" a JOIN "Interface" iface ON iface.id = a."interfaceId" '
        f"WHERE iface.\"deviceId\" = {q(sim_device_uuid(i))} AND iface.name = 'eth0' "
        f'AND iface."deletedAt" IS NULL LIMIT 1)'
    )


_DEVICE_COLS = "id name status role deviceType zoneId supplierId organizationId deviceModelId"


def _device(
    out: list[str], name: str, role: str, dtype: str, mfr: str, model: str, zone: str, org: str, refresh: str
) -> None:
    """A Device row, supplier-scoped so the per-role DCIM page lists it. `status` never refreshes."""
    out.append(
        emit_upsert(
            "Device",
            "id name status role deviceType zoneId supplierId organizationId deviceModelId",
            [
                q(did(f"device:{name}")),
                q(name),
                qe("ACTIVE", "DeviceStatus"),
                qe(role, "DeviceRole"),
                dtype,
                q(zone),
                q(org),
                q(org),
                _model_ref(mfr, model),
            ],
            "id",
            update=refresh,
        )
    )


def _peer_device(out: list[str], name: str, mfr: str, model: str, zone_id: str, org_id: str) -> None:
    dtype = qe("Baremetal", "DeviceType")
    refresh = "name zoneId supplierId organizationId deviceModelId"
    _device(out, name, "Baremetal", dtype, mfr, model, zone_id, org_id, refresh)


def _role_device(out: list[str], name: str, role: str, mfr: str, model: str, zone_id: str, org_id: str) -> None:
    """A facility device: a real DeviceRole and a NULL `deviceType` — no compute device-type."""
    refresh = "name role zoneId supplierId organizationId deviceModelId"
    _device(out, name, role, "NULL", mfr, model, zone_id, org_id, refresh)


def _extension(out: list[str], table: str, name: str, cols: str, values: list) -> None:
    """A facility device's MTI child row, keyed one-to-one on its parent `Device`.

    The child's own id prefix is the lowercased table name; the parent `deviceId` closes the row.
    """
    row = [q(did(f"{table.lower()}:{name}")), *values, q(did(f"device:{name}"))]
    out.append(emit_upsert(table, f"id {cols} deviceId", row, "deviceId"))


def _rack_assign(out: list[str], device_sql: str, label: str, pos: int, face: str, height_u: int) -> None:
    out.append(
        emit_upsert(
            "DeviceRackAssignment",
            "id position face heightU deviceId rackId",
            [q(did(f"rackassign:{label}")), pos, qe(face, "RackFace"), height_u, device_sql, q(RACK_ID)],
            "deviceId",
        )
    )


def _console_port(pid: str, name: str, ptype: str, speed: int, device_sql: str) -> str:
    return emit_upsert(
        "ConsolePort",
        "id name type speed deviceId",
        [q(pid), q(name), qe(ptype, "ConsolePortType"), speed, device_sql],
        "deviceId name",
    )


def _console_server_port(pid: str, name: str, device_sql: str) -> str:
    return emit_upsert(
        "ConsoleServerPort",
        "id name type speed deviceId",
        [q(pid), q(name), qe("RJ45", "ConsolePortType"), 9600, device_sql],
        "deviceId name",
    )


def _power_port(pid: str, name: str, ptype: str, maxdraw: int, alloc: int, device_sql: str) -> str:
    return emit_upsert(
        "PowerPort",
        "id name type maximumDraw allocatedDraw deviceId",
        [q(pid), q(name), qe(ptype, "PowerPortType"), maxdraw, alloc, device_sql],
        "deviceId name",
    )


def _power_outlet(pid: str, name: str, device_sql: str) -> str:
    return emit_upsert(
        "PowerOutlet",
        "id name type feedLegPhase deviceId",
        [q(pid), q(name), qe("IEC_C13", "PowerOutletType"), qe("A", "FeedLegPhase"), device_sql],
        "deviceId name",
    )


def _interface(pid: str, name: str, itype: str, device_sql: str, mgmt_only: bool = False, speed: int = 25000) -> str:
    return emit_upsert(
        "Interface",
        "id name type enabled mgmtOnly speed deviceId",
        [q(pid), q(name), qe(itype, "InterfaceType"), "true", str(mgmt_only).lower(), speed, device_sql],
        "deviceId name",
        update="type mgmtOnly speed",
        where='"deletedAt" IS NULL',
    )


def _rear_port(pid: str, name: str, device_sql: str) -> str:
    return emit_upsert(
        "RearPort",
        "id name type positions deviceId",
        [q(pid), q(name), qe("LC", "PortType"), 1, device_sql],
        "deviceId name",
    )


def _front_port(pid: str, name: str, rear_pid: str, device_sql: str) -> str:
    return emit_upsert(
        "FrontPort",
        "id name type rearPortId rearPortPosition deviceId",
        [q(pid), q(name), qe("LC", "PortType"), q(rear_pid), 1, device_sql],
        "deviceId name",
        update="type rearPortId",
    )


def _cable(out: list[str], label: str, ctype: str, a_type: str, a_id: str, b_type: str, b_id: str, clabel: str) -> None:
    cid = did(f"cable:{label}")
    out.append(
        emit_upsert(
            "Cable",
            "id type status label",
            [q(cid), qe(ctype, "CableType"), qe("CONNECTED", "CableStatus"), q(clabel)],
            "id",
        )
    )
    for side, ttype, tid in (("A", a_type, a_id), ("B", b_type, b_id)):
        term = [qe(side, "CableSide"), qe(ttype, "CableTerminationType"), tid, q(cid)]
        out.append(
            emit_upsert(
                "CableTermination",
                "id cableSide terminationType terminationId cableId",
                [q(did(f"cterm:{label}:{side}")), *term],
                "cableId cableSide",
                updated_at=False,
            )
        )


def _tag(name: str, color: str, org_id: str) -> str:
    return emit_upsert(
        "Tag",
        "id name slug color organizationId",
        [q(did(f"tag:{name}")), q(name), q(slugify(name)), q("#" + color), q(org_id)],
        "organizationId name",
    )


def _tag_assign(tag_name: str, obj_type: str, object_sql: str) -> str:
    return emit_upsert(
        "TagAssignment",
        "tagId objectType objectId",
        [q(did(f"tag:{tag_name}")), qe(obj_type, "TagObjectType"), object_sql],
        "tagId objectType objectId",
        do_nothing=True,
        updated_at=False,
    )


def generate() -> str:
    s = get_settings()
    org_id = s.sim.hydrahost_org_id
    zone_id = zone_uuid(0)

    fleet = require_fleet()
    if fleet.mode == "baremetal":
        return header("55-dcim.py") + "-- mode == baremetal: no sim VM DCIM decoration.\n"
    if not fleet.nodes:
        raise RuntimeError("fleet.yml has no nodes")
    servers = [(i, n.name) for i, n in enumerate(fleet.nodes) if n.seed_as_server]

    out: list[str] = [header("55-dcim.py"), "BEGIN;\n"]

    # ── Manufacturers + DeviceModels ────────────────────────────────────────────
    out.append("-- Manufacturers + device models (catalog for the Device-Models page)")
    for name in MANUFACTURERS:
        out.append(
            emit_upsert(
                "Manufacturer",
                "id name slug",
                [q(did(f"mfr:{name}")), q(name), q(slugify(name))],
                "name",
            )
        )
    out.append("\n-- Manufacturer contacts")
    for mfr, name, title, email, phone, notes, ticketing_portal, website in MANUFACTURER_CONTACTS:
        contact_id = did(f"mfr-contact:{mfr}:{email}")
        out.append(
            f"""INSERT INTO "Contact" (
    id, name, title, email, phone, notes, "ticketingPortalUrl", website,
    "manufacturerId", "createdAt", "updatedAt"
)
VALUES (
    {q(contact_id)}, {q(name)}, {q(title)}, {q(email)}, {q(phone)}, {q(notes)},
    {q(ticketing_portal)}, {q(website)},
    (SELECT id FROM "Manufacturer" WHERE name = {q(mfr)}), NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, title = EXCLUDED.title, email = EXCLUDED.email,
    phone = EXCLUDED.phone, notes = EXCLUDED.notes,
    "ticketingPortalUrl" = EXCLUDED."ticketingPortalUrl", website = EXCLUDED.website,
    "zoneId" = NULL, "organizationId" = NULL, "manufacturerId" = EXCLUDED."manufacturerId",
    "contactType" = NULL, "isShippingContact" = FALSE, "deletedAt" = NULL, "updatedAt" = NOW();"""
        )
    for mfr, model, ff, height_u, max_w, desc in MODELS:
        h = "NULL" if height_u is None else str(height_u)
        w = "NULL" if max_w is None else str(max_w)
        out.append(
            emit_upsert(
                "DeviceModel",
                "id manufacturer model slug formFactor heightU maxPowerW isFullDepth description",
                [
                    q(did(f"model:{mfr}|{model}")),
                    q(mfr),
                    q(model),
                    q(slugify(f"{mfr}-{model}")),
                    q(ff),
                    h,
                    w,
                    "true",
                    q(desc),
                ],
                "manufacturer model",
                update="formFactor heightU maxPowerW description",
            )
        )
    # Attach the server model to every cpu-N (they have no model from 50-devices).
    if servers:
        server_ids = ", ".join(q(sim_device_uuid(i)) for i, _ in servers)
        out.append(
            f"""UPDATE "Device" SET "deviceModelId" = {_model_ref(*SERVER_MODEL)}, "updatedAt" = NOW()
WHERE id IN ({server_ids});"""
        )

    # ── Rack roles + the single rack ────────────────────────────────────────────
    out.append("\n-- DCIM rack roles + the one shared sim rack")
    for name, slug, color in RACK_ROLES:
        out.append(
            emit_upsert(
                "DcimRackRole",
                "id name slug color",
                [q(did(f"rackrole:{slug}")), q(name), q(slug), q("#" + color)],
                "slug",
            )
        )
    out.append(
        emit_upsert(
            "Rack",
            "id name status role heightU zoneId organizationId description",
            [
                q(RACK_ID),
                q(RACK_NAME),
                qe("ACTIVE", "RackStatus"),
                qe("MIXED", "RackRole"),
                RACK_HEIGHT_U,
                q(zone_id),
                q(org_id),
                q("Simulated lab rack — every sim device mounts here"),
            ],
            "zoneId name",
        )
    )

    # ── Peer infrastructure devices ─────────────────────────────────────────────
    out.append("\n-- Peer infra devices (role=Baremetal + model, no MTI child rows — matches the app seed)")
    for name, mfr, model in PEERS:
        _peer_device(out, name, mfr, model, zone_id, org_id)

    def peer_ref(name: str) -> str:
        return q(did(f"device:{name}"))

    # Per-role facility devices (own DeviceRole + MTI child row): render on the per-role DCIM pages,
    # supplier-scoped. Not rack-mounted — avoids REAR-position collisions with the peers above.
    out.append("\n-- PDU-role devices (Device.role=PDU + Pdu child row) for /dcim/pdus")
    for name, mfr, model, outlets, amps, voltage, power in ROLE_PDUS:
        _role_device(out, name, "PDU", mfr, model, zone_id, org_id)
        child = [outlets, amps, q(voltage), qe(power, "PduPowerStatus")]
        _extension(out, "Pdu", name, "outletCount ratedAmperage voltageType powerStatus", child)

    out.append("\n-- CDU-role devices (Device.role=CDU + Cdu child row) for /dcim/cdus")
    for name, mfr, model, coolant, flow, thermal, airflow, power in ROLE_CDUS:
        _role_device(out, name, "CDU", mfr, model, zone_id, org_id)
        child = [q(coolant), flow, thermal, qe(airflow, "Airflow"), qe(power, "CduPowerStatus")]
        _extension(out, "Cdu", name, "coolantType ratedFlowRateLpm ratedThermalCapacityKw airflow powerStatus", child)

    out.append("\n-- Switch-role devices (Device.role=Switch + Switch child row) for /dcim/switches")
    for name, mfr, model, switch_role, fabric, port_count, power in ROLE_SWITCHES:
        _role_device(out, name, "Switch", mfr, model, zone_id, org_id)
        child = [q(switch_role), q(fabric), port_count, qe(power, "SwitchPowerStatus")]
        _extension(
            out,
            "Switch",
            name,
            "switchRole fabric portCount powerStatus",
            child,
        )

    out.append("\n-- Router-role devices (Device.role=Router + Router child row) for /dcim/routers")
    for name, mfr, model, router_type, bgp_asn, power in ROLE_ROUTERS:
        _role_device(out, name, "Router", mfr, model, zone_id, org_id)
        child = [q(router_type), bgp_asn, qe(power, "RouterPowerStatus")]
        _extension(out, "Router", name, "routerType bgpAsn powerStatus", child)

    out.append("\n-- RackBrush-role devices (Device.role=RackBrush + RackBrush child row) for /dcim/rack-brushes")
    for name, mfr, model, material, height_u in ROLE_RACK_BRUSHES:
        _role_device(out, name, "RackBrush", mfr, model, zone_id, org_id)
        _extension(out, "RackBrush", name, "brushMaterial rackUnitHeight", [q(material), height_u])

    out.append("\n-- PatchPanel-role devices (Device.role=PatchPanel + PatchPanel child row) for /dcim/patch-panels")
    for name, mfr, model, panel_type, port_count, height_u in ROLE_PATCH_PANELS:
        _role_device(out, name, "PatchPanel", mfr, model, zone_id, org_id)
        child = [q(panel_type), port_count, height_u]
        _extension(out, "PatchPanel", name, "panelType portCount rackUnitHeight", child)

    # Rack elevation: servers stack from the bottom on the FRONT face (2U each, odd Us 1,3,5,…);
    # peers hang off the REAR face at fixed top-of-rack Us, so they never collide on (position, face).
    out.append("\n-- Rack elevation")
    for i, _ in servers:
        _rack_assign(out, q(sim_device_uuid(i)), f"srv:{i}", 1 + i * 2, "FRONT", 2)
    _rack_assign(out, peer_ref(PDU), "pdu", RACK_HEIGHT_U, "REAR", 1)
    _rack_assign(out, peer_ref(SWITCH), "tor", RACK_HEIGHT_U - 1, "REAR", 1)
    _rack_assign(out, peer_ref(CONSERVER), "conserver", RACK_HEIGHT_U - 2, "REAR", 1)
    _rack_assign(out, peer_ref(PATCH), "patch", RACK_HEIGHT_U - 3, "REAR", 1)

    # ── Ports: servers (console + power), then each peer's ports ────────────────
    out.append("\n-- Server console + power ports")
    for i, _ in servers:
        sid = q(sim_device_uuid(i))
        out.append(_console_port(did(f"cport:srv:{i}"), "Console", "RJ45", 115200, sid))
        out.append(_power_port(did(f"pport:srv:{i}"), "PSU1", "IEC_C14", 800, 400, sid))

    # One swp uplink per server (swp1..swpN) + 2 dedicated ports for the patch-panel
    # cross-connects, so server links never collide with patch links regardless of fleet size.
    patch_front_swp = len(servers) + 1
    patch_rear_swp = len(servers) + 2
    out.append(f"\n-- Switch interfaces (mgmt0 + swp1..swp{patch_rear_swp})")
    out.append(_interface(did("if:tor:mgmt0"), "mgmt0", "ETHERNET_1G", peer_ref(SWITCH), mgmt_only=True, speed=1000))
    for p in range(1, patch_rear_swp + 1):
        out.append(_interface(did(f"if:tor:swp{p}"), f"swp{p}", "ETHERNET_25G", peer_ref(SWITCH), speed=25000))

    out.append("\n-- PDU input port + outlets")
    out.append(_power_port(did("pport:pdu:input"), "INPUT", "IEC_C20", 17000, 0, peer_ref(PDU)))
    for i, _ in servers:
        out.append(_power_outlet(did(f"poutlet:{i}"), f"Outlet-{i + 1}", peer_ref(PDU)))

    out.append("\n-- Console-server mgmt + aggregator ports")
    out.append(_interface(did("if:cs:mgmt0"), "mgmt0", "ETHERNET_1G", peer_ref(CONSERVER), mgmt_only=True, speed=1000))
    for i, _ in servers:
        out.append(_console_server_port(did(f"csport:{i}"), f"port-{i + 1:02d}", peer_ref(CONSERVER)))

    out.append("\n-- Patch-panel rear + front ports")
    for n in (1, 2):
        out.append(_rear_port(did(f"rport:{n}"), f"RP-{n:02d}", peer_ref(PATCH)))
        out.append(_front_port(did(f"fport:{n}"), f"FP-{n:02d}", did(f"rport:{n}"), peer_ref(PATCH)))

    # ── Cables: wire it together (exercises every CableTermination type) ────────
    out.append("\n-- Cables")
    for pos, (i, name) in enumerate(servers):
        _cable(
            out,
            f"net:{i}",
            "DAC",
            "INTERFACE",
            _eth0_ref(i),
            "INTERFACE",
            q(did(f"if:tor:swp{pos + 1}")),
            f"{name} eth0 → {SWITCH} swp{pos + 1}",
        )
        _cable(
            out,
            f"pwr:{i}",
            "POWER",
            "POWER_PORT",
            q(did(f"pport:srv:{i}")),
            "POWER_OUTLET",
            q(did(f"poutlet:{i}")),
            f"{name} PSU1 → {PDU} Outlet-{i + 1}",
        )
        _cable(
            out,
            f"con:{i}",
            "SERIAL",
            "CONSOLE_PORT",
            q(did(f"cport:srv:{i}")),
            "CONSOLE_SERVER_PORT",
            q(did(f"csport:{i}")),
            f"{name} Console → {CONSERVER} port-{i + 1:02d}",
        )
    _cable(
        out,
        "patch-front",
        "SMF_OS2",
        "FRONT_PORT",
        q(did("fport:1")),
        "INTERFACE",
        q(did(f"if:tor:swp{patch_front_swp}")),
        f"{PATCH} FP-01 → {SWITCH} swp{patch_front_swp}",
    )
    _cable(
        out,
        "patch-rear",
        "SMF_OS2",
        "REAR_PORT",
        q(did("rport:2")),
        "INTERFACE",
        q(did(f"if:tor:swp{patch_rear_swp}")),
        f"{PATCH} RP-02 → {SWITCH} swp{patch_rear_swp}",
    )

    # ── Tags + assignments ──────────────────────────────────────────────────────
    out.append("\n-- Tags + assignments")
    for name, color in TAGS:
        out.append(_tag(name, color, org_id))
    for i, _ in servers:
        out.append(_tag_assign("Compute", "DEVICE", q(sim_device_uuid(i))))
        out.append(_tag_assign("Managed", "DEVICE", q(sim_device_uuid(i))))
    out.append(_tag_assign("Networking", "DEVICE", peer_ref(SWITCH)))
    out.append(_tag_assign("Power", "DEVICE", peer_ref(PDU)))
    out.append(_tag_assign("OOB", "DEVICE", peer_ref(CONSERVER)))
    out.append(_tag_assign("Managed", "ZONE", q(zone_id)))

    # ── BGP: ASNs, peer group, prefix list + rules, sessions ────────────────────
    out.append("\n-- BGP")
    for asn, desc, key in [
        (65000, "Brokkr sim (local)", "asn:65000"),
        (64512, "Upstream transit (remote)", "asn:64512"),
    ]:
        out.append(
            emit_upsert(
                "Asn",
                "id asn description organizationId",
                [q(did(key)), asn, q(desc), q(org_id)],
                "asn",
            )
        )
    out.append(
        emit_upsert(
            "BgpPeerGroup",
            "id name description organizationId",
            [q(did("pg:transit")), q("transit-upstream"), q("eBGP to upstream transit"), q(org_id)],
            "id",
            update="name description",
        )
    )
    out.append(
        emit_upsert(
            "PrefixList",
            "id name description family organizationId",
            [q(did("pl:out")), q("advertise-out"), q("Prefixes advertised to transit"), q("ipv4"), q(org_id)],
            "id",
            update="name description",
        )
    )
    rules = [
        (10, "permit", fleet.network.cidr),
        (20, "permit", fleet.network.bmc_cidr),
        (30, "deny", "0.0.0.0/0"),
    ]
    for seq, action, prefix in rules:
        out.append(
            emit_upsert(
                "PrefixListRule",
                "id action prefix sequence prefixListId",
                [q(did(f"plr:{seq}")), q(action), q(prefix), seq, q(did("pl:out"))],
                "id",
                update="action prefix sequence",
            )
        )
    # ToR peers upstream; cpu-1 carries a planned session bound to its real eth0 IP.
    out.append(
        emit_upsert(
            "BgpSession",
            f"{_BGP_SESSION_COLS} organizationId",
            [
                q(did("bgp:tor")),
                q("tor-upstream"),
                qe("ACTIVE", "BgpSessionStatus"),
                peer_ref(SWITCH),
                q(did("asn:65000")),
                q(did("asn:64512")),
                q(did("pg:transit")),
                q(did("pl:out")),
                q(org_id),
            ],
            "id",
            update=f"{_BGP_SESSION_UPDATE} organizationId",
        )
    )
    # localAddressId is re-resolved every run: 50-devices deletes+recreates the eth0 IpAddress (new id),
    # which SetNulls this FK, so the upsert MUST refresh it or the session loses its local address.
    if servers:
        first_i, first_name = servers[0]
        out.append(
            emit_upsert(
                "BgpSession",
                f"{_BGP_SESSION_COLS} localAddressId organizationId",
                [
                    q(did("bgp:cpu0")),
                    q(f"{first_name}-upstream"),
                    qe("PLANNED", "BgpSessionStatus"),
                    q(sim_device_uuid(first_i)),
                    q(did("asn:65000")),
                    q(did("asn:64512")),
                    q(did("pg:transit")),
                    q(did("pl:out")),
                    _eth0_ip_ref(first_i),
                    q(org_id),
                ],
                "id",
                update=f"{_BGP_SESSION_UPDATE} localAddressId organizationId",
            )
        )

    # ── Circuits: provider, type, circuit + termination into the zone ───────────
    out.append("\n-- Circuits")
    out.append(
        emit_upsert(
            "Provider",
            "id name slug description",
            [q(did("prov:sim")), q("Sim Transit Co"), q("sim-transit"), q("Simulated upstream transit provider")],
            "slug",
        )
    )
    out.append(
        emit_upsert(
            "ProviderNetwork",
            "id name description providerId",
            [q(did("provnet:sim")), q("Sim Transit Backbone"), q("Provider backbone network"), q(did("prov:sim"))],
            "providerId name",
        )
    )
    out.append(
        emit_upsert(
            "CircuitType",
            "id name slug description",
            [q(did("ct:transit")), q("Internet Transit"), q("internet-transit"), q("IP transit circuit")],
            "slug",
        )
    )
    out.append(
        emit_upsert(
            "Circuit",
            "id cid status commitRate providerId circuitTypeId organizationId description",
            [
                q(did("circ:001")),
                q("SIM-XC-001"),
                qe("ACTIVE", "CircuitStatus"),
                1000000,
                q(did("prov:sim")),
                q(did("ct:transit")),
                q(org_id),
                q("1G IP transit into the sim zone"),
            ],
            "id",
            update="status commitRate",
        )
    )
    out.append(
        emit_upsert(
            "CircuitTermination",
            "id termSide portSpeed upstreamSpeed xconnectId circuitId zoneId",
            [
                q(did("cterm:001:A")),
                qe("A", "CircuitTerminationSide"),
                1000000,
                1000000,
                q("XC-SIM-001-A"),
                q(did("circ:001")),
                q(zone_id),
            ],
            "circuitId termSide",
            update="portSpeed upstreamSpeed zoneId",
        )
    )

    out.append("\nCOMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
