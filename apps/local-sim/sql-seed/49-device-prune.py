#!/usr/bin/env python
"""Generator: retire ``Device`` rows for fleet nodes that no longer exist → SQL.

``Device.id`` derives from a node's flat list position (``derived.sim_device_uuid`` = index+1), so
shrinking the fleet leaves the departed tail behind as active inventory forever — nothing else in the
seed removes it. Runs before ``50``/``51``, which together own ``sim_device_uuid(0..n-1)``.

Soft-delete, not DELETE: all three ``Device`` unique indexes are partial on ``deletedAt IS NULL``, so
one update frees every one of them and no foreign key needs unwinding. Numbering: 49 < 50."""

from __future__ import annotations

from local.config import get_settings
from local.schema import require_fleet
from local.sqlemit import header, logs_to_stderr, q
from local.zones import BRIDGE_ORDINAL_BASE


def _prune_sql(org_id: str, node_count: int) -> str:
    """Retire numeric-tail sim device ids above the live node count.

    The upper bound is what keeps a bridge safe: bridges take the same numeric namespace from
    BRIDGE_ORDINAL_BASE up (``zones.bridge_device_uuid``), while bare-metal and unassigned devices
    are uuid5 and never match the digit pattern at all.
    """
    return f"""-- retire fleet-node devices above the live node count ({node_count})
UPDATE "Device"
SET "deletedAt" = NOW(), "updatedAt" = NOW()
WHERE "deletedAt" IS NULL
  AND "supplierId" = {q(org_id)}
  AND id LIKE '00000000-0000-0000-0000-%'
  AND right(id, 12) ~ '^[0-9]{{12}}$'
  AND right(id, 12)::bigint > {node_count}
  AND right(id, 12)::bigint < {BRIDGE_ORDINAL_BASE};
"""


def generate() -> str:
    s = get_settings()
    fleet = require_fleet()
    out: list[str] = [header("49-device-prune.py"), "BEGIN;\n\n"]
    out.append(_prune_sql(s.sim.hydrahost_org_id, len(fleet.nodes)))
    out.append("COMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
