"""Print a fleet node's ``Server.storageLayouts`` as JSON, read from Hub Postgres.

Reflects the live seed (not a recomputed shape) — the disk catalog a provision
request's ``diskLayouts`` must agree with.
Usage: ``python -m local.disk_layouts <node-name-or-index>``  → JSON on stdout.
"""

from __future__ import annotations

import json
import sys

from local.fleet import _node_device_ids, load_fleet, resolve_index
from local.stores import HubDB


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        raise SystemExit("usage: python -m local.disk_layouts <node-name-or-index>")
    fleet = load_fleet()
    idx = resolve_index(argv[0], fleet)
    node = fleet.nodes[idx]
    # BMC-IP join, not positional index — a decommission/re-seed leaves index and Device.id misaligned
    device_id = _node_device_ids(fleet).get(node.name)
    if device_id is None:
        raise SystemExit(f"error: node {node.name} has no seeded Hub device row — run `task sim:seed`")

    layouts = HubDB.from_env().get_storage_layouts(device_id)
    if not layouts:
        raise SystemExit(f"device {device_id} has no seeded storageLayouts — run `task sim:seed`")

    out = {
        "node": node.name,
        "deviceId": device_id,
        "configs": layouts.get("configs") or [],
        "default": layouts.get("default") or {},
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
