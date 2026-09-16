"""Shared ``Device``/``Interface``/``IpAddress`` SQL emitters for the per-device seed generators. Pure — no I/O."""

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
VIRTUAL_NIC = SeededNic(name="vip0", iface_type="VIRTUAL", mgmt_only=False, description="VRRP virtual IP")


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


def emit_ip_address_clear(address: str, org: str) -> str:
    """Free ``address`` in the default VRF of ``org``, so a re-seed survives a renamed nic.

    Matches IpAddress_active_unique exactly — (organizationId, vrfId, address) among live rows — so
    it frees what the insert would collide with and nothing else. The seed writes no vrfId, so a row
    in another VRF is a different key and must survive, as must a soft-deleted twin.
    """
    return f"""DELETE FROM "IpAddress"
WHERE address = {q(address)}::inet AND "organizationId" = {org}
    AND "vrfId" IS NULL AND "deletedAt" IS NULL;"""


def emit_device_name_clear(device_id: str, zone_id: str, name: str, org: str) -> str:
    """Free (supplier, zone, name) when a DIFFERENT row holds it, so a shifted Device.id can take it.

    Device.id derives from the node's flat list position, so removing a non-terminal node moves
    every later id. The upsert then renames whichever row now sits at that id, which collides with
    the row the node used to occupy on Device_active_onboarding_name_unique. `id <>` keeps a plain
    re-seed a no-op: the clause only fires when some other row is squatting on the name.
    """
    return f"""UPDATE "Device" SET "deletedAt" = NOW(), "updatedAt" = NOW()
WHERE "deletedAt" IS NULL AND "zoneId" = {q(zone_id)} AND name = {q(name)}
  AND id <> {q(device_id)} AND "supplierId" = {org};"""


def emit_device_zone_move_prep(device_id: str, zone_id: str) -> str:
    """Drop this device's seals bound to another zone, so its Device row can change custody zone.

    ``DeviceSecret`` references ``Device(id, zoneId)`` with ``onUpdate: Restrict``: a seal is sealed
    to one zone's enrollment key, so the FK refuses the zoneId rewrite rather than let a device carry
    a secret its new zone cannot open. ``zone-crypto:seed-bmc`` re-seals after ``sim:seed``, so the
    cost is one re-seal. ``zoneId <>`` keeps a plain re-seed a no-op.
    """
    return f"""DELETE FROM "DeviceSecret"
WHERE "deviceId" = {q(device_id)} AND "zoneId" <> {q(zone_id)};"""


def emit_role_trigger(on: bool) -> str:
    """Toggle ``Device.role``'s write-once trigger around a generator's device writes.

    ``block_device_role_change`` permits only Server->DiscoveredHost, while the seed partitions one
    id space by ``seed_as_server`` — so flipping that flag asks for the refused Server->NULL.
    ``scripts/local/reconcile_baremetal.py`` brackets it the same way. ``ALTER TABLE`` holds ACCESS
    EXCLUSIVE on ``Device`` until COMMIT, and an aborted seed rolls the disable back with it.
    """
    return f'ALTER TABLE "Device" {"ENABLE" if on else "DISABLE"} TRIGGER device_role_write_once;'


def emit_ip_on_interface(device_id: str, nic: SeededNic, address: str, org: str) -> list[str]:
    """Delete-then-insert ``address`` on this device's live ``nic``, as three separate statements.

    ``address`` must already carry any prefix length. ``org`` is emitted verbatim, so callers pass a
    ``Zone`` subquery rather than a literal. ``assignedObjectType``/``Id`` mirror the discovery
    write-path (``common/ipam ensureIpAddress``): ``interfaceId`` is the canonical FK, but the
    polymorphic pair is dual-written for IPAM reads.
    """
    return [
        emit_ip_delete(device_id, nic),
        emit_ip_address_clear(address, org),
        f"""INSERT INTO "IpAddress"
    (id, address, status, "organizationId", "interfaceId", "assignedObjectType", "assignedObjectId", "updatedAt")
SELECT gen_random_uuid(), {q(address)}::inet, 'ACTIVE'::"IpStatus", {org},
    id, 'Interface'::"AssignedObjectType", id, NOW()
FROM "Interface" WHERE "deviceId" = {q(device_id)} AND name = {q(nic.name)} AND "deletedAt" IS NULL;""",
    ]
