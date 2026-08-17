#!/usr/bin/env python
"""Generator: rich sim ``Zone`` fixtures and role=Bridge devices → SQL.

Reads zones from the rendered ``fleet.yml``. The Zone carries the ``organizationId`` that
``50-devices`` reads back via subquery, so this applies first (numbering: 45 < 50). Each zone
gets addresses, contacts, maintenance history, and stable bridge rows."""

from __future__ import annotations

import uuid

from local.config import get_settings
from local.schema import require_fleet
from local.sqlemit import header, logs_to_stderr, q
from local.zones import bridge_device_uuid, bridge_ordinal, spoke_port_blocks, zone_uuid

_ID_NAMESPACE = uuid.UUID("45a0e000-0000-4000-8000-000000000000")


def _row_id(zone_id: str, label: str) -> str:
    return str(uuid.uuid5(_ID_NAMESPACE, f"{zone_id}:{label}"))


def _zone_sql(zone_id: str, zone_name: str, org_id: str) -> str:
    return f"""-- sim zone {zone_id} ({zone_name}) → org={org_id}
INSERT INTO "Zone" (id, name, "uuidSuffix", "organizationId", "updatedAt")
VALUES ({q(zone_id)}, {q(zone_name)}, {q(zone_id[-5:])}, {q(org_id)}, NOW())
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    "uuidSuffix" = EXCLUDED."uuidSuffix",
    "organizationId" = EXCLUDED."organizationId",
    "updatedAt" = NOW();
"""


def _zone_details_sql(zone_id: str, zone_index: int) -> str:
    primary_id = _row_id(zone_id, "address:primary")
    shipping_id = _row_id(zone_id, "address:shipping")
    main_id = _row_id(zone_id, "contact:main")
    facilities_id = _row_id(zone_id, "contact:facilities")
    technical_id = _row_id(zone_id, "contact:technical")
    historical_maintenance_id = _row_id(zone_id, "maintenance:historical")
    network_maintenance_id = _row_id(zone_id, "maintenance:active")
    suffix = "" if zone_index == 0 else f"-{zone_index}"
    return f"""INSERT INTO "ZoneAddress" (
    id, type, "formattedAddress", "addressLineOne", "addressLineTwo", city,
    "stateOrProvince", "postalCode", country, "countryCode", latitude, longitude,
    timezone, "zoneId", "createdAt", "updatedAt"
) VALUES
    ({q(primary_id)}, 'PRIMARY'::"ZoneAddressType",
     '100 Brokkr Way, Austin, TX 78701, United States', '100 Brokkr Way', 'Suite 400',
     'Austin', 'TX', '78701', 'United States', 'US', 30.2672, -97.7431,
     'America/Chicago', {q(zone_id)}, NOW(), NOW()),
    ({q(shipping_id)}, 'SHIPPING'::"ZoneAddressType",
     '500 Logistics Blvd, Dallas, TX 75201, United States', '500 Logistics Blvd', 'Dock 12',
     'Dallas', 'TX', '75201', 'United States', 'US', 32.7767, -96.7970,
     'America/Chicago', {q(zone_id)}, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    type = EXCLUDED.type, "formattedAddress" = EXCLUDED."formattedAddress",
    "addressLineOne" = EXCLUDED."addressLineOne", "addressLineTwo" = EXCLUDED."addressLineTwo",
    city = EXCLUDED.city, "stateOrProvince" = EXCLUDED."stateOrProvince",
    "postalCode" = EXCLUDED."postalCode", country = EXCLUDED.country,
    "countryCode" = EXCLUDED."countryCode", latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude, timezone = EXCLUDED.timezone,
    "zoneId" = EXCLUDED."zoneId", "deletedAt" = NULL, "updatedAt" = NOW();

INSERT INTO "Contact" (
    id, name, title, email, phone, "contactType", "isShippingContact",
    "zoneId", "createdAt", "updatedAt"
) VALUES
    ({q(main_id)}, 'Jordan Lee', 'Zone Operations Manager',
     {q(f"jordan.lee{suffix}@brokkr.local")}, '+15125550100',
     'Main'::"ZoneContactType", TRUE, {q(zone_id)}, NOW(), NOW()),
    ({q(facilities_id)}, 'Morgan Chen', 'Facilities Manager',
     {q(f"morgan.chen{suffix}@brokkr.local")}, '+15125550101',
     'Main'::"ZoneContactType", FALSE, {q(zone_id)}, NOW(), NOW()),
    ({q(technical_id)}, 'Riley Patel', 'Network Engineer',
     {q(f"riley.patel{suffix}@brokkr.local")}, '+15125550102',
     'Technical'::"ZoneContactType", FALSE, {q(zone_id)}, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, title = EXCLUDED.title, email = EXCLUDED.email,
    phone = EXCLUDED.phone, "contactType" = EXCLUDED."contactType",
    "isShippingContact" = EXCLUDED."isShippingContact", "zoneId" = EXCLUDED."zoneId",
    "deletedAt" = NULL, "updatedAt" = NOW();

INSERT INTO "ZoneMaintenance" (
    id, "zoneId", reason, message, "expectedEndAt", "enabledAt", "enabledBy",
    "disabledAt", "disabledBy", "createdAt", "updatedAt"
)
SELECT {q(historical_maintenance_id)}, {q(zone_id)}, 'Quarterly generator service',
       'Generator testing completed successfully.', NULL, NOW() - INTERVAL '30 days', u.id,
       NOW() - INTERVAL '29 days', u.id, NOW() - INTERVAL '30 days', NOW()
FROM "User" u WHERE u.email = 'brokkr@brokkr.local'
ON CONFLICT (id) DO UPDATE SET
    reason = EXCLUDED.reason, message = EXCLUDED.message, "expectedEndAt" = EXCLUDED."expectedEndAt",
    "enabledAt" = EXCLUDED."enabledAt", "enabledBy" = EXCLUDED."enabledBy",
    "disabledAt" = EXCLUDED."disabledAt", "disabledBy" = EXCLUDED."disabledBy", "updatedAt" = NOW();

INSERT INTO "ZoneMaintenance" (
    id, "zoneId", reason, message, "expectedEndAt", "enabledAt", "enabledBy",
    "disabledAt", "disabledBy", "createdAt", "updatedAt"
)
SELECT {q(network_maintenance_id)}, {q(zone_id)}, 'Network fabric upgrade',
       'Network fabric upgrade completed successfully.',
       NOW() - INTERVAL '6 days', NOW() - INTERVAL '7 days', u.id,
       NOW() - INTERVAL '6 days', u.id, NOW() - INTERVAL '7 days', NOW()
FROM "User" u WHERE u.email = 'brokkr@brokkr.local'
ON CONFLICT (id) DO UPDATE SET
    reason = EXCLUDED.reason, message = EXCLUDED.message,
    "expectedEndAt" = EXCLUDED."expectedEndAt", "enabledAt" = EXCLUDED."enabledAt",
    "enabledBy" = EXCLUDED."enabledBy", "disabledAt" = EXCLUDED."disabledAt",
    "disabledBy" = EXCLUDED."disabledBy", "updatedAt" = NOW();
"""


def _bridge_sql(zone_id: str, bridge_name: str, bridge_id: str, org_id: str) -> str:
    return f"""-- role=Bridge device (+ 1:1 Bridge row) for the zone-detail "Bridges" card.
-- organizationId is the org-ownership FK the admin Bridges view joins on
-- (Device.organization) and MUST equal zone.organizationId — without it the
-- bridge reads back with a null zone/org and looks disconnected from the zone.
WITH up AS (
    INSERT INTO "Device" (
        id, name, status, role, "deviceType",
        "zoneId", "supplierId", "organizationId", "updatedAt"
    ) VALUES (
        {q(bridge_id)}, {q(bridge_name)}, 'PLANNED'::"DeviceStatus",
        'Bridge'::"DeviceRole", 'Baremetal'::"DeviceType",
        {q(zone_id)}, {q(org_id)}, {q(org_id)}, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, role = EXCLUDED.role, "zoneId" = EXCLUDED."zoneId",
        "supplierId" = EXCLUDED."supplierId", "organizationId" = EXCLUDED."organizationId", "updatedAt" = NOW()
    RETURNING id
)
INSERT INTO "Bridge" (id, "deviceId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), id, NOW(), NOW() FROM up
ON CONFLICT ("deviceId") DO NOTHING;
"""


def _bridge_name(base: str, zone_index: int, zone_name: str, b: int) -> str:
    """Globally-unique bridge name, paralleling spoke process names in ``modules/spoke.nix``;
    zone 0 / bridge 0 keeps the bare base name."""
    if zone_index == 0:
        return base if b == 0 else f"{base}-{b}"
    return f"{base}-{zone_name}" + ("" if b == 0 else f"-{b}")


def _maintenance_fixture_zone_sql(org_id: str) -> str:
    """Extra zone (not in the fleet topology) kept under active maintenance for admin ops UI."""
    zone_id = str(uuid.uuid5(_ID_NAMESPACE, "fixture:maintenance-zone"))
    address_id = _row_id(zone_id, "address:primary")
    contact_id = _row_id(zone_id, "contact:main")
    maintenance_id = _row_id(zone_id, "maintenance:active")
    return f"""-- admin ops fixture: zone permanently in maintenance (no bridges / fleet nodes)
{_zone_sql(zone_id, "sim-zone-maintenance", org_id)}
INSERT INTO "ZoneAddress" (
    id, type, "formattedAddress", "addressLineOne", "addressLineTwo", city,
    "stateOrProvince", "postalCode", country, "countryCode", latitude, longitude,
    timezone, "zoneId", "createdAt", "updatedAt"
) VALUES (
    {q(address_id)}, 'PRIMARY'::"ZoneAddressType",
    '200 Maintenance Rd, Austin, TX 78702, United States', '200 Maintenance Rd', NULL,
    'Austin', 'TX', '78702', 'United States', 'US', 30.2672, -97.7431,
    'America/Chicago', {q(zone_id)}, NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    type = EXCLUDED.type, "formattedAddress" = EXCLUDED."formattedAddress",
    "addressLineOne" = EXCLUDED."addressLineOne", "addressLineTwo" = EXCLUDED."addressLineTwo",
    city = EXCLUDED.city, "stateOrProvince" = EXCLUDED."stateOrProvince",
    "postalCode" = EXCLUDED."postalCode", country = EXCLUDED.country,
    "countryCode" = EXCLUDED."countryCode", latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude, timezone = EXCLUDED.timezone,
    "zoneId" = EXCLUDED."zoneId", "deletedAt" = NULL, "updatedAt" = NOW();

INSERT INTO "Contact" (
    id, name, title, email, phone, "contactType", "isShippingContact",
    "zoneId", "createdAt", "updatedAt"
) VALUES (
    {q(contact_id)}, 'Casey Brooks', 'Maintenance Lead',
    'casey.brooks@brokkr.local', '+15125550999',
    'Technical'::"ZoneContactType", FALSE, {q(zone_id)}, NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, title = EXCLUDED.title, email = EXCLUDED.email,
    phone = EXCLUDED.phone, "contactType" = EXCLUDED."contactType",
    "isShippingContact" = EXCLUDED."isShippingContact", "zoneId" = EXCLUDED."zoneId",
    "deletedAt" = NULL, "updatedAt" = NOW();

INSERT INTO "ZoneMaintenance" (
    id, "zoneId", reason, message, "expectedEndAt", "enabledAt", "enabledBy",
    "disabledAt", "disabledBy", "createdAt", "updatedAt"
)
SELECT {q(maintenance_id)}, {q(zone_id)}, 'Cooling plant outage',
       'Zone offline for cooling plant repairs. ETA tomorrow.',
       NOW() + INTERVAL '1 day', NOW() - INTERVAL '2 hours', u.id,
       NULL, NULL, NOW() - INTERVAL '2 hours', NOW()
FROM "User" u WHERE u.email = 'brokkr@brokkr.local'
ON CONFLICT (id) DO UPDATE SET
    reason = EXCLUDED.reason, message = EXCLUDED.message,
    "expectedEndAt" = EXCLUDED."expectedEndAt", "enabledAt" = EXCLUDED."enabledAt",
    "enabledBy" = EXCLUDED."enabledBy", "disabledAt" = EXCLUDED."disabledAt",
    "disabledBy" = EXCLUDED."disabledBy", "updatedAt" = NOW();
"""


def generate() -> str:
    s = get_settings()
    org_id = s.sim.hydrahost_org_id

    # Fleet.zones synthesizes the legacy zone 0 when the fleet declares no `zones:` block,
    # so a single-zone fleet still emits the historical one-zone/one-bridge SQL.
    zones = require_fleet().zones
    # global bridge ordinal per zone (same ordering as the spoke port blocks) → unique ids.
    blocks = spoke_port_blocks([(z.index, z.bridges) for z in zones])

    out: list[str] = [header("45-zone.py"), "BEGIN;\n\n"]
    for z in sorted(zones, key=lambda zz: zz.index):
        zid = zone_uuid(z.index)
        out.append(_zone_sql(zid, z.name, org_id))
        out.append(_zone_details_sql(zid, z.index))
        base = blocks[z.index]["base_ordinal"]
        for b in range(z.bridges):
            bname = _bridge_name(s.sim.bridge_name, z.index, z.name, b)
            bridge_id = bridge_device_uuid(bridge_ordinal(base + b))
            out.append(_bridge_sql(zid, bname, bridge_id, org_id))
    out.append(_maintenance_fixture_zone_sql(org_id))
    out.append("COMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
