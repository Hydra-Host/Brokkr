"""Shared ``Interface`` + ``IpAddress`` SQL emitters for the per-device seed generators. Pure — no I/O."""

from __future__ import annotations

from dataclasses import dataclass

from local.sqlemit import q


@dataclass(frozen=True)
class SeededNic:
    """One seeded NIC shape — every ``Interface`` column except the device and the MAC."""

    name: str
    iface_type: str
    mgmt_only: bool
    description: str


DATA_NIC = SeededNic(name="eth0", iface_type="ETHERNET_1G", mgmt_only=False, description="Primary data NIC")
IPMI_NIC = SeededNic(name="IPMI", iface_type="IPMI_BMC", mgmt_only=True, description="BMC management interface")


def emit_interface(device_id: str, nic: SeededNic, mac: str) -> str:
    """Upsert one ``Interface`` row on ``device_id``.

    Keys on the partial unique index ``("deviceId", name) WHERE "deletedAt" IS NULL``, so a
    soft-deleted row of the same name can neither block the upsert nor be revived by it.
    """
    return f"""INSERT INTO "Interface"
    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description, "updatedAt")
VALUES (gen_random_uuid(), {q(nic.name)}, {q(nic.iface_type)}::"InterfaceType", true,
    {q(mac)}, {"true" if nic.mgmt_only else "false"}, {q(device_id)}, {q(nic.description)}, NOW())
ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET
    type = EXCLUDED.type, "macAddress" = EXCLUDED."macAddress",
    "mgmtOnly" = EXCLUDED."mgmtOnly", "updatedAt" = NOW();"""


def emit_ip_delete(device_id: str, nic: SeededNic) -> str:
    """Clear every ``IpAddress`` on this device's live ``nic``, leaving a soft-deleted twin's alone."""
    return f"""DELETE FROM "IpAddress" WHERE "interfaceId" IN
    (SELECT id FROM "Interface" WHERE "deviceId" = {q(device_id)} AND name = {q(nic.name)} AND "deletedAt" IS NULL);"""


def emit_ip_on_interface(device_id: str, nic: SeededNic, address: str, org: str) -> list[str]:
    """Delete-then-insert ``address`` on this device's live ``nic``, as two separate statements.

    ``address`` must already carry any prefix length. ``org`` is emitted verbatim, so callers pass a
    ``Zone`` subquery rather than a literal. ``assignedObjectType``/``Id`` mirror the discovery
    write-path (``common/ipam ensureIpAddress``): ``interfaceId`` is the canonical FK, but the
    polymorphic pair is dual-written for IPAM reads.
    """
    return [
        emit_ip_delete(device_id, nic),
        f"""INSERT INTO "IpAddress"
    (id, address, status, "organizationId", "interfaceId", "assignedObjectType", "assignedObjectId", "updatedAt")
SELECT gen_random_uuid(), {q(address)}::inet, 'ACTIVE'::"IpStatus", {org},
    id, 'Interface'::"AssignedObjectType", id, NOW()
FROM "Interface" WHERE "deviceId" = {q(device_id)} AND name = {q(nic.name)} AND "deletedAt" IS NULL;""",
    ]
