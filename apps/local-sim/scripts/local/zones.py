"""Zone derivation for the multi-spoke (N-zone) sim — one spoke instance == one zone.

Everything a zone needs is derived from its 0-based index (pure, no ``Settings``) so index 0
is byte-identical to the historical single-zone UUID/ports and ``zone_count=1`` is a no-op.
"""

from __future__ import annotations

from dataclasses import dataclass

# Zone 0 must equal the historical constant. The tail is ten '1's + a 2-digit
# suffix; suffix 11 -> "...111111111111" (twelve '1's). Valid for indices 0..88.
_UUID_PREFIX = "00000000-0000-0000-0000-1111111111"
HTTP_PORT_BASE = 8000
GRPC_PORT_BASE = 9082
# Bridge Device.id is derived from this ordinal (8000, 8001, …) so it stays deterministic
# and distinct from the per-node server UUIDs (1, 2, …, see derived.sim_device_uuid).
BRIDGE_ORDINAL_BASE = 8000


@dataclass(frozen=True)
class Zone:
    """A single sim zone (== one spoke instance)."""

    index: int
    id: str
    name: str
    http_port: int
    grpc_port: int
    bridge_ordinal: int


def zone_uuid(index: int) -> str:
    """Deterministic Zone UUID for a 0-based index (index 0 == legacy constant)."""
    if not 0 <= index <= 88:
        raise ValueError(f"zone index {index} out of supported range 0..88")
    return f"{_UUID_PREFIX}{11 + index:02d}"


def zone_name(index: int, base: str = "sim-zone") -> str:
    """Zone display name; index 0 keeps the bare base name for back-compat."""
    return base if index == 0 else f"{base}-{index}"


def http_port(index: int, base: int = HTTP_PORT_BASE) -> int:
    return base + index


def grpc_port(index: int, base: int = GRPC_PORT_BASE) -> int:
    return base + index


def bridge_ordinal(index: int, base: int = BRIDGE_ORDINAL_BASE) -> int:
    return base + index


def bridge_device_uuid(ordinal: int) -> str:
    """Deterministic Hub ``Device.id`` for a bridge at the given global ordinal.

    Encodes the ordinal into the UUID tail so re-seeds are idempotent and never collide
    with the per-node server UUIDs (``derived.sim_device_uuid`` uses index+1)."""
    return f"00000000-0000-0000-0000-{ordinal:012d}"


def node_zone_index(node_index: int, zone_count: int) -> int:
    """Round-robin a node onto a zone by its fleet position (count>=1)."""
    if zone_count < 1:
        raise ValueError("zone_count must be >= 1")
    return node_index % zone_count


def zones(zone_count: int, *, name_base: str = "sim-zone") -> list[Zone]:
    """The full zone list for ``zone_count`` spokes (one HA bridge each)."""
    if zone_count < 1:
        raise ValueError("zone_count must be >= 1")
    return [
        Zone(
            index=i,
            id=zone_uuid(i),
            name=zone_name(i, name_base),
            http_port=http_port(i),
            grpc_port=grpc_port(i),
            bridge_ordinal=bridge_ordinal(i),
        )
        for i in range(zone_count)
    ]


def spoke_port_blocks(zone_bridges: list[tuple[int, int]]) -> dict[int, dict[str, int]]:
    """Per-zone contiguous spoke port blocks over a flat global ordinal.

    Zones (sorted by index) get contiguous ordinal blocks; replica ``b`` binds
    ``http_port(base_ordinal + b)`` / ``grpc_port(base_ordinal + b)``. The Nix
    ``spoke``/``ports`` modules mirror this exact ordering, so engine and supervisor
    agree without a shared registry. ``zone_bridges``: ``(zone_index, bridges)`` pairs.
    """
    blocks: dict[int, dict[str, int]] = {}
    ordinal = 0
    for zi, bridges in sorted(zone_bridges):
        if bridges < 1:
            raise ValueError(f"zone {zi}: bridges must be >= 1, got {bridges}")
        blocks[zi] = {"base_ordinal": ordinal, "bridges": bridges}
        ordinal += bridges
    return blocks
