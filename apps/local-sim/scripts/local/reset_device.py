#!/usr/bin/env python
"""Reset a fleet node's Hub + spoke state back to clean INVENTORY."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import psycopg
import redis

from local import bm_power
from local.commission_baremetal import CommissionError, load_bmc_creds
from local.config import get_settings
from local.derived import bm_device_uuid, sim_device_uuid
from local.fleet import load_fleet, resolve_index
from local.logger import log
from local.schema import BareMetalNodeResolved, Fleet

# Sibling expansion filters on Reservation."endDate" IS NULL throughout: a closed historical
# reservation must not drag siblings into the reset (would end another node's open deployment).
_OPEN_SIBLING_SERVERS = (
    '  SELECT sir2."serverId" FROM "ServersInReservation" sir2 '
    '  JOIN "Reservation" r2 ON r2.id = sir2."reservationId" '
    '  WHERE r2."endDate" IS NULL '
    '    AND sir2."reservationId" IN ('
    '      SELECT sir."reservationId" FROM "ServersInReservation" sir '
    '      JOIN "Reservation" r ON r.id = sir."reservationId" '
    '      WHERE sir."serverId" = %s AND r."endDate" IS NULL'
    "    )"
)


def _discover_affected_devices(cur: psycopg.Cursor, device_id: str) -> list[tuple[str, str, str]]:
    """Read-only: resolve target + open-reservation siblings as (device_id, name, zone_id) tuples.

    Run BEFORE any mutation so we know which fleet VMs need power-cycling.
    """
    cur.execute('SELECT id FROM "Server" WHERE "deviceId" = %s', (device_id,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"device {device_id} has no Server row (run sim:seed first)")
    server_id = row[0]
    cur.execute(
        f'SELECT d.id, d.name, d."zoneId" FROM "Device" d '
        f'JOIN "Server" s ON s."deviceId" = d.id '
        f"WHERE s.id = %s OR s.id IN ({_OPEN_SIBLING_SERVERS})",
        (server_id, server_id),
    )
    return [(r[0], r[1], r[2]) for r in cur.fetchall()]


def _reset_postgres(
    cur: psycopg.Cursor,
    target_device_id: str,
    affected_device_ids: list[str],
    *,
    bm: bool = False,
) -> dict[str, int]:
    """Apply hub-side cleanup on the open cursor without committing (caller commits after Redis, so a
    Redis failure rolls the hub back).

    ``target_device_id`` (not an arbitrary list element) anchors the sibling-expansion subqueries.
    ``bm=True`` also soft-deletes data-NIC (``mgmtOnly=false``) IpAddress rows so a stale collection
    IP can't win the next ``getDataIpByBootMac`` poll (VM data IPs are statically seeded, so gated off).
    """
    counts: dict[str, int] = {}
    cur.execute('SELECT id FROM "Server" WHERE "deviceId" = %s', (target_device_id,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"device {target_device_id} has no Server row (run sim:seed first)")
    server_id = row[0]

    cur.execute(
        f'UPDATE "Deployment" SET "endDate" = NOW(), "updatedAt" = NOW() '
        f'WHERE "endDate" IS NULL AND ("serverId" = %s OR "serverId" IN ({_OPEN_SIBLING_SERVERS}))',
        (server_id, server_id),
    )
    counts["deployments_closed"] = cur.rowcount

    cur.execute(
        'UPDATE "Reservation" SET "endDate" = NOW(), "updatedAt" = NOW() '
        'WHERE "endDate" IS NULL '
        'AND id IN (SELECT "reservationId" FROM "ServersInReservation" WHERE "serverId" = %s)',
        (server_id,),
    )
    counts["reservations_closed"] = cur.rowcount

    cur.execute(
        f'UPDATE "Server" SET "lifecycleStatus" = \'INVENTORY\', "updatedAt" = NOW() '
        f"WHERE \"lifecycleStatus\" != 'INVENTORY' "
        f"AND (id = %s OR id IN ({_OPEN_SIBLING_SERVERS}))",
        (server_id, server_id),
    )
    counts["lifecycle_reset"] = cur.rowcount

    # Per-device spoke-side cleanup covers target + open-reservation siblings, else the hub looks
    # clean while sibling spoke history (Jobs) stays stale.
    cur.execute('DELETE FROM "Job" WHERE "deviceId" = ANY(%s)', (affected_device_ids,))
    counts["jobs_deleted"] = cur.rowcount

    cur.execute(
        "UPDATE \"Device\" SET status = 'ACTIVE', \"updatedAt\" = NOW() WHERE id = ANY(%s) AND status != 'ACTIVE'",
        (affected_device_ids,),
    )
    counts["device_status_reset"] = cur.rowcount

    if bm:
        cur.execute(
            'UPDATE "IpAddress" ip SET "deletedAt" = NOW(), "updatedAt" = NOW() '
            'FROM "Interface" ii '
            'WHERE ip."interfaceId" = ii.id '
            '  AND ii."mgmtOnly" = false '  # data NICs only (eth0 + collected eno1/enp…); keep the BMC/IPMI iface
            '  AND ii."deviceId" = ANY(%s) '
            '  AND ip."deletedAt" IS NULL',
            (affected_device_ids,),
        )
        counts["data_nic_ips_cleared"] = cur.rowcount

    return counts


# Spoke BullMQ queues holding per-device saga jobs. `stalled-check`/`meta`/`id`/`events` are
# intentionally excluded — they aren't per-job and removing them would corrupt the worker.
_SAGA_QUEUES = ("lifecycle", "collection")
_SAGA_QUEUE_LISTS = ("wait", "active", "paused")
_SAGA_QUEUE_ZSETS = ("delayed", "completed", "failed", "waiting-children", "prioritized")
_SAGA_QUEUE_SETS = ("stalled",)


def _reset_redis(url: str, devices: list[tuple[str, str]]) -> dict[str, int]:
    """Clear spoke atom/BullMQ state for every affected device (target + siblings); each entry is (device_id, zone_id).

    Two-phase: scan_iter to collect (read-only), then a MULTI/EXEC pipeline so every DELETE lands
    atomically; the caller commits Postgres only after this succeeds.
    """
    r = redis.Redis.from_url(url)
    all_atom_keys: list[str] = []
    all_bull_keys: list[str] = []
    # Stale saga jobs from prior runs: the bullmq worker retries them on a 5s loop, racing the
    # next user-driven saga for the device lock until a hub Reboot/Rescue call 503s. Zap them too.
    saga_jobs_by_queue: dict[tuple[str, str], list[str]] = {}

    for device_id, zone_id in devices:
        atom_keys = [
            f"{zone_id}:device:{device_id}:device_record",
            f"{zone_id}:device:{device_id}:pointers",
            f"{zone_id}:device:{device_id}:config:netplan:live",
        ]
        for key in r.scan_iter(match=f"{zone_id}:device:{device_id}:lifecycle:*", count=200):
            atom_keys.append(key.decode() if isinstance(key, bytes) else key)
        all_atom_keys.extend(atom_keys)

        for key in r.scan_iter(match=f"bull:device-status-effects:device-{device_id}-*", count=200):
            all_bull_keys.append(key.decode() if isinstance(key, bytes) else key)

        for queue in _SAGA_QUEUES:
            prefix = f"{zone_id}:{queue}:"
            for key in r.scan_iter(match=f"{prefix}{device_id}-*", count=200):
                k = key.decode() if isinstance(key, bytes) else key
                saga_jobs_by_queue.setdefault((zone_id, queue), []).append(k[len(prefix) :])

    counts: dict[str, int] = {"atom_keys_deleted": 0, "bull_effects_deleted": 0, "saga_jobs_deleted": 0}
    if not all_atom_keys and not all_bull_keys and not saga_jobs_by_queue:
        return counts
    with r.pipeline(transaction=True) as pipe:
        if all_atom_keys:
            pipe.delete(*all_atom_keys)
        if all_bull_keys:
            pipe.delete(*all_bull_keys)
        # Drop each job's hash + clear its id from every queue index (lists vs zsets vs sets) so the
        # worker can't pop a phantom ref — the atomic removal upstream `Job.remove` does.
        for (zone_id, queue), job_ids in saga_jobs_by_queue.items():
            prefix = f"{zone_id}:{queue}:"
            pipe.delete(*[f"{prefix}{jid}" for jid in job_ids])
            for jid in job_ids:
                for idx in _SAGA_QUEUE_LISTS:
                    pipe.lrem(f"{prefix}{idx}", 0, jid)
                for idx in _SAGA_QUEUE_ZSETS:
                    pipe.zrem(f"{prefix}{idx}", jid)
                for idx in _SAGA_QUEUE_SETS:
                    pipe.srem(f"{prefix}{idx}", jid)
        results = pipe.execute()
    i = 0
    if all_atom_keys:
        counts["atom_keys_deleted"] = int(results[i])
        i += 1
    if all_bull_keys:
        counts["bull_effects_deleted"] = int(results[i])
        i += 1
    per_job_ops = len(_SAGA_QUEUE_LISTS) + len(_SAGA_QUEUE_ZSETS) + len(_SAGA_QUEUE_SETS)
    for job_ids in saga_jobs_by_queue.values():
        counts["saga_jobs_deleted"] += int(results[i])
        # Skip past the per-jobId LREM/ZREM/SREM responses for this queue.
        i += 1 + len(job_ids) * per_job_ops
    return counts


# sim repo root. The redfish shim (scripts/tasks/redfish.sh) embeds a `python -c` importing
# `local.*`, which only resolves with cwd at the sim repo — so pin cwd here for direct invocation.
_SIM_ROOT = Path(__file__).resolve().parent.parent.parent
_REDFISH_SHIM = _SIM_ROOT / "scripts" / "tasks" / "redfish.sh"


def _power_cycle(node_name: str) -> int:
    # Direct call to the shim — bypasses the `task redfish` wrapper so the lab
    # API doesn't drag in the task CLI as a runtime dep.
    proc = subprocess.run(
        ["bash", str(_REDFISH_SHIM), node_name, "power-cycle"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        cwd=_SIM_ROOT,
    )
    if proc.stdout.strip():
        log.detail(proc.stdout.strip().splitlines()[-1])
    if proc.returncode != 0 and proc.stderr.strip():
        log.warn(proc.stderr.strip().splitlines()[-1])
    return proc.returncode


def _resolve_bm_node(fleet: Fleet, arg: str) -> BareMetalNodeResolved:
    """Resolve ``arg`` to a bare-metal node by name (clear SystemExit on miss).

    Name-only here — keeps the reset CLI's resolution symmetric with the VM (index-or-name) branch.
    """
    for n in fleet.bm_nodes:
        if n.name == arg:
            return n
    names = ", ".join(n.name for n in fleet.bm_nodes) or "(none)"
    raise SystemExit(f"unknown bare-metal node {arg!r} (available: {names})")


def _bm_cycle_targets(fleet: Fleet, affected: list[tuple[str, str, str]]) -> list[BareMetalNodeResolved]:
    """Map affected Device.ids back to bm nodes via ``bm_device_uuid(pxe_mac)``.

    The bm device_id is a uuid5 of pxe_mac — match by the same derivation the seed used.
    """
    by_uuid = {bm_device_uuid(n.pxe_mac): n for n in fleet.bm_nodes}
    targets: list[BareMetalNodeResolved] = []
    for d_id, _hub_name, _ in affected:
        node = by_uuid.get(d_id)
        if node is not None:
            targets.append(node)
    # dedupe preserving discovery order
    seen: set[str] = set()
    out: list[BareMetalNodeResolved] = []
    for n in targets:
        if n.name not in seen:
            seen.add(n.name)
            out.append(n)
    return out


def _main_baremetal(fleet: Fleet, arg: str) -> None:
    node = _resolve_bm_node(fleet, arg)
    device_id = bm_device_uuid(node.pxe_mac)
    settings = get_settings()
    log.info(f"reset {node.name} ({device_id[-4:]}) → clean INVENTORY [bare-metal]")

    with psycopg.connect(settings.stores.hub_database_url) as conn, conn.cursor() as cur:
        affected = _discover_affected_devices(cur, device_id)

    cycle_nodes = _bm_cycle_targets(fleet, affected)
    if len(affected) > 1:
        log.info(f"co-reserved siblings will also reset: {len(affected) - 1} device(s)")
    if not cycle_nodes:
        # Canonical Server row exists but no affected device maps to a bm node — the hub row is
        # stray/shadowed vs fleet.yml (reconcile_baremetal's case). Don't auto-run it (--yes-destroy).
        raise SystemExit(
            f"no bare-metal nodes resolved for affected devices {[d for d, _, _ in affected]} — "
            "the canonical Device row is out of sync with fleet.yml. Run `sim:bm:reconcile` + re-seed."
        )

    # Boot every affected box into brokkr-live FIRST (any failure aborts before touching
    # hub/redis). action="auto": box may be OFF (INVENTORY), so boot reads PowerState first.
    for n in cycle_nodes:
        log.info(f"boot {n.name} into brokkr-live (clears stale session; boot-source→PXE)")
        try:
            creds = load_bmc_creds(n.name)
            # expected_uuid == the same node's derived uuid (trivially equal here);
            # the wrong-machine guard still runs for defense in depth.
            bm_power.boot_into_live(n, creds, bm_device_uuid(n.pxe_mac), action="auto")
        except (bm_power.BmPowerError, CommissionError) as e:
            raise SystemExit(f"boot for {n.name} failed ({e}) — reset aborted (hub/redis untouched)") from None

    affected_device_ids = [d_id for d_id, _, _ in affected]
    affected_for_redis = [(d_id, z_id) for d_id, _, z_id in affected]
    with psycopg.connect(settings.stores.hub_database_url) as conn, conn.cursor() as cur:
        pg_counts = _reset_postgres(cur, device_id, affected_device_ids, bm=True)
        for k, v in pg_counts.items():
            log.detail(f"postgres: {k}={v}")

        redis_counts = _reset_redis(settings.stores.bridge_redis_url, affected_for_redis)
        for k, v in redis_counts.items():
            log.detail(f"redis: {k}={v}")
        conn.commit()

    log.success(f"reset complete for {node.name}")


def _main_vm(fleet: Fleet, arg: str) -> None:
    idx = resolve_index(arg, fleet)
    node = fleet.nodes[idx]
    device_id = sim_device_uuid(idx)

    settings = get_settings()
    log.info(f"reset {node.name} ({device_id[-4:]}) → clean INVENTORY")

    # Discover siblings BEFORE any mutation (read-only) so we know which VMs to power-cycle —
    # otherwise a sibling keeps a stale brokkr-live session and next provision blocks on discovery.
    with psycopg.connect(settings.stores.hub_database_url) as conn, conn.cursor() as cur:
        affected = _discover_affected_devices(cur, device_id)

    # Map affected Device.id back to fleet position via the deterministic sim UUID scheme — bypasses
    # Hub Device.name, so a rename-without-reseed still recovers the correct fleet node.
    cycle_names: list[str] = []
    for d_id, _hub_name, _ in affected:
        try:
            idx_for_device = int(d_id.split("-")[-1]) - 1
        except ValueError:
            continue
        if 0 <= idx_for_device < len(fleet.nodes):
            cycle_names.append(fleet.nodes[idx_for_device].name)
    cycle_names = list(dict.fromkeys(cycle_names))
    if len(affected) > 1:
        log.info(f"co-reserved siblings will also reset: {len(affected) - 1} device(s)")
    if not cycle_names:
        # Should be impossible — the target IS in the fleet (resolved above) and always in `affected`.
        # Getting here means hub state is so out of sync that touching it without a cycle worsens it.
        raise SystemExit(
            f"no fleet nodes resolved for affected devices {[d for d, _, _ in affected]} — "
            f"hub seed is out of sync with the current fleet.yml? (re-run sim:seed)"
        )

    # Power-cycle every affected fleet node FIRST — any failure aborts before touching hub/spoke
    # state, else hub shows INVENTORY while VMs still host stale brokkr-live sessions.
    for name in cycle_names:
        log.info(f"power-cycle {name} (clears stale brokkr-live session)")
        rc = _power_cycle(name)
        if rc != 0:
            raise SystemExit(f"power-cycle for {name} failed (exit {rc}) — reset aborted (hub/redis untouched)")

    # Atomic hub + redis cleanup: commit only after Redis succeeds, so a Redis failure rolls the
    # hub back instead of leaving postgres clean + spoke atoms stale.
    affected_device_ids = [d_id for d_id, _, _ in affected]
    affected_for_redis = [(d_id, z_id) for d_id, _, z_id in affected]
    with psycopg.connect(settings.stores.hub_database_url) as conn, conn.cursor() as cur:
        pg_counts = _reset_postgres(cur, device_id, affected_device_ids)
        for k, v in pg_counts.items():
            log.detail(f"postgres: {k}={v}")

        redis_counts = _reset_redis(settings.stores.bridge_redis_url, affected_for_redis)
        for k, v in redis_counts.items():
            log.detail(f"redis: {k}={v}")
        conn.commit()

    log.success(f"reset complete for {node.name}")


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        raise SystemExit("usage: python -m local.reset_device <node-name-or-index>")
    fleet = load_fleet()
    if fleet is None:
        raise SystemExit("no fleet.yml found — run `task up` (or fleet:init) first")
    # Self-detect bm mode so the lab keeps calling `local.reset_device <name>`
    # unchanged (test.service.ts:764) across both modes.
    if fleet.mode == "baremetal":
        _main_baremetal(fleet, argv[0])
    else:
        _main_vm(fleet, argv[0])


if __name__ == "__main__":
    main(sys.argv[1:])
