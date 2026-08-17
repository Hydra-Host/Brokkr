#!/usr/bin/env python
"""Force discovery on a fleet node and poll until its storageLayouts change.

The node must be powered on and in brokkr-live so the agent can answer.
Usage: ``python -m local.discover <node-name-or-index> [--timeout SECS] [--json]``
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from local.fleet import _node_device_ids, load_fleet, resolve_index
from local.hub_client import HubClient, HubUnreachable
from local.logger import log

DEFAULT_TIMEOUT = 420
_POLL_INTERVAL = 10


def _disk_signature(server: dict | None) -> tuple[int, list[str]]:
    """(total disks, sorted group names) from a server detail's storageLayouts —
    changes when discovery recomposes the layout."""
    configs = ((server or {}).get("storageLayouts") or {}).get("configs") or []
    total = sum(len(c.get("disks") or []) for c in configs)
    groups = sorted(str(c.get("disk_group_name")) for c in configs)
    return (total, groups)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m local.discover", description="Force discovery on a fleet node.")
    p.add_argument("node", help="node name or index")
    p.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"seconds to wait for storageLayouts to change (default {DEFAULT_TIMEOUT}); a timeout exits 2",
    )
    p.add_argument("--json", action="store_true", help="print a single JSON result doc to stdout (logger → stderr)")
    return p.parse_args(argv)


def main(argv: list[str]) -> None:
    args = _parse_args(argv)
    if args.json:
        log.use_stderr_only()
    fleet = load_fleet()
    idx = resolve_index(args.node, fleet)
    node = fleet.nodes[idx]
    # BMC-IP join, not positional index — a decommission/re-seed leaves index and Device.id misaligned
    device_id = _node_device_ids(fleet).get(node.name)
    if device_id is None:
        raise SystemExit(f"error: node {node.name} has no seeded Hub device row — run `task sim:seed`")

    client = HubClient()
    try:
        client.sign_in()
        code, server = client.get_server(device_id)
        if code != 200:
            # a failed read must not become the (0, []) baseline — any later successful
            # read would differ from it and fake a landed discovery
            raise SystemExit(f"error: baseline server read failed ({code}): {server}")
        before = _disk_signature(server)
        code, body = client.force_discovery(device_id)
    except HubUnreachable as e:
        raise SystemExit(str(e)) from None
    if code != 200:
        raise SystemExit(f"error: force-discovery rejected ({code}): {body}")
    job_id = (body or {}).get("jobId")
    if not job_id:
        raise SystemExit(f"error: collect-inventory returned 200 without a jobId: {body}")
    log.info(f"forced discovery on {node.name} ({device_id[-4:]}) — storageLayouts had {before[0]} disk(s)")
    log.detail("the node must be powered on + in brokkr-live so the agent can answer collection")
    log.success(f"inventory_collection enqueued (job {job_id}) — collecting hardware…")

    started = time.time()
    deadline = started + args.timeout
    after = before
    landed = False
    while True:
        # clamp the poll sleep to the remaining budget so a sub-interval --timeout is honored tightly
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        time.sleep(min(_POLL_INTERVAL, remaining))
        # the saga is already enqueued — transient poll failures are retried until the
        # deadline rather than compared as (0, []) or crashing the wait
        try:
            code, server = client.get_server(device_id)
        except HubUnreachable as e:
            log.detail(f"hub unreachable — retrying until timeout: {e}")
            continue
        if code != 200:
            log.detail(f"server detail read failed ({code}) — retrying until timeout")
            continue
        after = _disk_signature(server)
        log.detail(f"storageLayouts: {after[0]} disk(s) in {after[1]}")
        if after != before:
            landed = True
            log.success(f"discovery landed — storageLayouts now has {after[0]} disk(s); open the disk-layout picker")
            break

    if not landed:
        log.warn(
            "no storageLayouts change within timeout — expected if the node's disks already match; "
            "otherwise check the spoke logs (is the node in brokkr-live with the agent connected?)"
        )

    if args.json:
        print(
            json.dumps(
                {
                    "node": node.name,
                    "deviceId": device_id,
                    "jobId": job_id,
                    "disksBefore": before[0],
                    "disksAfter": after[0],
                    "landed": landed,
                    "timedOut": not landed,
                    "elapsedSec": round(time.time() - started, 1),
                }
            ),
            flush=True,
        )
    if not landed:
        raise SystemExit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
