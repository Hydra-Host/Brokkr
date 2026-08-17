"""`local.disk_layouts` resolves the device id via the BMC-IP join and must exit cleanly
for a node with no seeded Hub Device row instead of reading another device's layouts."""

from __future__ import annotations

import types

import pytest
from local import disk_layouts


def test_disk_layouts_fails_when_node_has_no_seeded_device(monkeypatch):
    node = types.SimpleNamespace(name="gpu-1")
    monkeypatch.setattr(disk_layouts, "load_fleet", lambda: types.SimpleNamespace(nodes=[node]))
    monkeypatch.setattr(disk_layouts, "_node_device_ids", lambda fleet: {})

    with pytest.raises(SystemExit) as exc:
        disk_layouts.main(["0"])

    assert "no seeded Hub device row" in str(exc.value)
