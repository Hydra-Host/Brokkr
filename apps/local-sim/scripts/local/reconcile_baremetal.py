from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import urlparse

import psycopg
import redis

from local.commission_baremetal import BareMetalNode, load_baremetal_nodes, select_nodes
from local.config import get_settings
from local.derived import bm_device_uuid
from local.logger import log

HERMETIC_ORG_ID = "00000000-0000-0000-0000-000000000000"
HERMETIC_ZONE_ID = "00000000-0000-0000-0000-111111111111"

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ReconcileRefused(RuntimeError):
    pass


def _mac_lookup_value(mac: str) -> str:
    return mac.lower().replace(":", "-")


def assert_hermetic_local(settings) -> tuple[str, str]:
    dsn_host = urlparse(settings.stores.hub_database_url).hostname
    if dsn_host not in _LOOPBACK_HOSTS:
        raise ReconcileRefused(f"hub DSN host {dsn_host!r} is not loopback — refusing (shared-infra guard)")
    redis_host = urlparse(settings.stores.bridge_redis_url).hostname
    if redis_host not in _LOOPBACK_HOSTS:
        raise ReconcileRefused(f"Bridge Redis host {redis_host!r} is not loopback — refusing")
    if os.environ.get("LOCAL_SIMULATION_ENABLED", "").strip().lower() != "true":
        raise ReconcileRefused("LOCAL_SIMULATION_ENABLED != true — refusing (sim-only tool)")
    org = settings.sim.hydrahost_org_id
    zone = settings.bridge.zone_id
    if org != HERMETIC_ORG_ID:
        raise ReconcileRefused(f"org id {org!r} is not the hermetic sim org — refusing")
    if zone != HERMETIC_ZONE_ID:
        raise ReconcileRefused(f"zone id {zone!r} is not the hermetic sim zone — refusing")
    return org, zone


def _devices_carrying_mac(
    cur, org: str, zone: str, macs: list[str], include_deleted: bool = False
) -> list[tuple[str, str | None]]:
    del_pred = "" if include_deleted else 'AND d."deletedAt" IS NULL AND i."deletedAt" IS NULL'
    cur.execute(
        f"""
        SELECT DISTINCT d.id, d.role::text, d."createdAt"
        FROM "Device" d
        JOIN "Interface" i ON i."deviceId" = d.id
        WHERE d."organizationId" = %s
          AND d."zoneId" = %s
          AND lower(i."macAddress") = ANY(%s)
          {del_pred}
        ORDER BY d."createdAt" DESC
        """,
        (org, zone, [m.lower() for m in macs]),
    )
    return [(row[0], row[1]) for row in cur.fetchall()]


def _soft_delete_stray(cur, org: str, zone: str, device_id: str) -> None:
    cur.execute(
        'UPDATE "Interface" SET "deletedAt" = NOW() WHERE "deviceId" = %s AND "deletedAt" IS NULL',
        (device_id,),
    )
    cur.execute(
        'UPDATE "Device" SET "deletedAt" = NOW() WHERE id = %s AND "organizationId" = %s AND "zoneId" = %s',
        (device_id, org, zone),
    )


def _repair_canonical_role(cur, org: str, zone: str, device_id: str) -> None:
    cur.execute('ALTER TABLE "Device" DISABLE TRIGGER device_role_write_once')
    try:
        cur.execute(
            """UPDATE "Device"
               SET role = 'Server'::"DeviceRole", status = 'ACTIVE'::"DeviceStatus", "deletedAt" = NULL
               WHERE id = %s AND "organizationId" = %s AND "zoneId" = %s""",
            (device_id, org, zone),
        )
    finally:
        cur.execute('ALTER TABLE "Device" ENABLE TRIGGER device_role_write_once')


def _purge_redis_pointers(rds: redis.Redis, zone: str, node: BareMetalNode, dead_ids: list[str]) -> int:
    deleted = 0
    for kind, mac in (("mac", node.pxe_mac), ("ipmi_mac", node.bmc_mac)):
        deleted += rds.delete(f"{zone}:device:lookup:{kind}:{_mac_lookup_value(mac)}")
    dead_set = set(dead_ids)
    for key in rds.scan_iter(match=f"{zone}:device:lookup:*", count=500):
        value = rds.get(key)
        if value is None:
            continue
        resolved = value.decode() if isinstance(value, bytes) else value
        if resolved in dead_set:
            deleted += rds.delete(key)
    for dead in dead_ids:
        for match in rds.scan_iter(match=f"{zone}:*{dead}*", count=500):
            deleted += rds.delete(match)
    return deleted


def reconcile_node(cur, org: str, zone: str, node: BareMetalNode) -> tuple[list[str], list[str]]:
    canonical = bm_device_uuid(node.pxe_mac)
    found = _devices_carrying_mac(cur, org, zone, [node.pxe_mac, node.bmc_mac])
    log.info(f"{node.name}: canonical={canonical}; devices carrying its MACs: {[d for d, _ in found] or 'none'}")

    strays: list[str] = []
    canonical_seen = False
    for device_id, role in found:
        if device_id != canonical:
            log.warn(f"{node.name}: soft-deleting stray Device {device_id} (role={role}) sharing the box MACs")
            _soft_delete_stray(cur, org, zone, device_id)
            strays.append(device_id)
        else:
            canonical_seen = True
            if role != "Server":
                log.warn(f"{node.name}: canonical {device_id} role={role} — restoring Server/ACTIVE (trigger-safe)")
                _repair_canonical_role(cur, org, zone, device_id)
            else:
                log.success(f"{node.name}: canonical row {device_id} already role=Server — kept")

    all_carrying = _devices_carrying_mac(cur, org, zone, [node.pxe_mac, node.bmc_mac], include_deleted=True)

    if not canonical_seen:
        # The live scan missed the canonical row. If it exists only soft-deleted, revive it here:
        # re-seed alone can't (ON CONFLICT DO UPDATE never clears deletedAt; role restore trips the trigger).
        if any(d == canonical for d, _ in all_carrying):
            log.warn(f"{node.name}: canonical {canonical} is soft-deleted — reviving Server/ACTIVE (trigger-safe)")
            _repair_canonical_role(cur, org, zone, canonical)
        else:
            log.detail(f"{node.name}: no canonical row yet — `sim:seed` will INSERT it as Server/ACTIVE")

    dead_ids = sorted({d for d, _ in all_carrying if d != canonical})
    return strays, dead_ids


def run(name: str | None) -> int:
    settings = get_settings()
    org, zone = assert_hermetic_local(settings)
    nodes = select_nodes(load_baremetal_nodes(), name)
    log.info(f"reconciling {len(nodes)} bare-metal node(s) in org {org} / zone {zone}")

    rds = redis.from_url(settings.stores.bridge_redis_url)
    total_dead: list[str] = []
    purges: list[tuple[BareMetalNode, list[str]]] = []
    with psycopg.connect(settings.stores.hub_database_url) as conn:
        with conn.cursor() as cur:
            for node in nodes:
                strays, dead_ids = reconcile_node(cur, org, zone, node)
                total_dead += strays
                purges.append((node, dead_ids))
        conn.commit()

    # Purge Redis pointers only AFTER the PG soft-deletes commit — purging mid-transaction would
    # strand Redis pointers without their rows if the commit never lands.
    for node, dead_ids in purges:
        purged = _purge_redis_pointers(rds, zone, node, dead_ids)
        log.detail(
            f"{node.name}: purged {purged} Redis key(s) (pointers valued at strays {dead_ids or 'none'} + atoms)"
        )

    if total_dead:
        log.success(f"soft-deleted {len(total_dead)} stray Device row(s): {total_dead}")
    log.info("re-run `sim:seed` (the sim:bm:reconcile task does) to refresh canonical interfaces/IPs")
    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m local.reconcile_baremetal",
        description="Reconcile bare-metal Device identity to bm_device_uuid(pxe_mac) (delete strays + purge Redis).",
    )
    parser.add_argument("--node", default=None, help="Bare-metal node name (default: all baremetal nodes)")
    parser.add_argument(
        "--yes-destroy",
        action="store_true",
        help="REQUIRED confirmation: this DELETEs hub Device rows + Bridge Redis pointers.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    if not args.yes_destroy:
        log.error("refusing without --yes-destroy — this DELETEs hub Device rows + Bridge Redis pointers")
        return 2
    try:
        return run(args.node)
    except ReconcileRefused as e:
        log.error(f"reconcile refused: {e}")
        return 2
    except Exception as e:
        log.error(f"reconcile failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
