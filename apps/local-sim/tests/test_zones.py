"""Zone derivation invariants for the multi-spoke sim."""

from __future__ import annotations

import pytest
from local.zones import (
    grpc_port,
    http_port,
    node_zone_index,
    spoke_port_blocks,
    zone_name,
    zone_uuid,
    zones,
)

LEGACY_ZONE_UUID = "00000000-0000-0000-0000-111111111111"


def test_zone0_is_byte_identical_to_legacy():
    assert zone_uuid(0) == LEGACY_ZONE_UUID
    assert zone_name(0) == "sim-zone"
    assert http_port(0) == 8000
    assert grpc_port(0) == 9082


def test_zone_uuids_are_unique_and_stepped():
    ids = [zone_uuid(i) for i in range(5)]
    assert len(set(ids)) == 5
    assert zone_uuid(1) == "00000000-0000-0000-0000-111111111112"


def test_ports_step_by_index():
    assert [http_port(i) for i in range(3)] == [8000, 8001, 8002]
    assert [grpc_port(i) for i in range(3)] == [9082, 9083, 9084]


def test_round_robin_assignment():
    assert [node_zone_index(i, 1) for i in range(4)] == [0, 0, 0, 0]
    assert [node_zone_index(i, 2) for i in range(4)] == [0, 1, 0, 1]
    assert [node_zone_index(i, 3) for i in range(5)] == [0, 1, 2, 0, 1]


def test_zones_list_shape():
    zs = zones(3)
    assert [z.index for z in zs] == [0, 1, 2]
    assert zs[0].id == LEGACY_ZONE_UUID
    assert zs[2].name == "sim-zone-2"
    assert zs[1].http_port == 8001 and zs[1].grpc_port == 9083


def test_spoke_port_blocks_single_zone_is_legacy():
    blocks = spoke_port_blocks([(0, 1)])
    assert blocks == {0: {"base_ordinal": 0, "bridges": 1}}
    # legacy single spoke → :8000 / :9082
    assert http_port(blocks[0]["base_ordinal"]) == 8000
    assert grpc_port(blocks[0]["base_ordinal"]) == 9082


def test_spoke_port_blocks_are_contiguous_and_non_overlapping():
    # zone 0: 2 bridges, zone 1: 3 bridges → ordinals 0,1 | 2,3,4
    blocks = spoke_port_blocks([(1, 3), (0, 2)])  # unsorted input → sorted by index
    assert blocks[0] == {"base_ordinal": 0, "bridges": 2}
    assert blocks[1] == {"base_ordinal": 2, "bridges": 3}
    # materialize every replica's ports and assert no collisions
    http_ports, grpc_ports = [], []
    for _zi, b in blocks.items():
        for r in range(b["bridges"]):
            http_ports.append(http_port(b["base_ordinal"] + r))
            grpc_ports.append(grpc_port(b["base_ordinal"] + r))
    assert http_ports == [8000, 8001, 8002, 8003, 8004]
    assert grpc_ports == [9082, 9083, 9084, 9085, 9086]
    assert len(set(http_ports)) == len(http_ports)


def test_spoke_port_blocks_rejects_zero_bridges():
    with pytest.raises(ValueError, match="bridges must be >= 1"):
        spoke_port_blocks([(0, 0)])


@pytest.mark.parametrize("bad", [0, -1, 90])
def test_out_of_range_rejected(bad):
    with pytest.raises(ValueError):
        if bad <= 0:
            node_zone_index(0, bad)
        else:
            zone_uuid(bad)
