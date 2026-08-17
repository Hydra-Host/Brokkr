"""cmd_init / cmd_up drive fleet-progress.json through the BRINGUP_SEQUENCE (heavy build + libvirt
steps stubbed — this asserts the progress WIRING + ordering, not real builds)."""

from __future__ import annotations

import argparse
import types
from pathlib import Path

import pytest
from local import fleet, progress
from local.progress import Step


@pytest.fixture(autouse=True)
def _state(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))


def test_cmd_init_records_typed_steps_in_order(monkeypatch):
    recorded: list[Step] = []
    monkeypatch.setattr(progress, "set", lambda step, **k: recorded.append(step))
    stubbed = (
        "preflight",
        "ensure_sudo_cached",
        "ensure_state_dirs",
        "assert_discovery_images_served",
        "build_grub_binaries",
        "prefetch_node_discovery_initrd",
        "build_ipxe_for_node",
    )
    for n in stubbed:
        monkeypatch.setattr(fleet, n, lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet, "build_live_initrd", lambda: (Path("/dev/null"), False))
    monkeypatch.setattr(fleet, "build_bridge_agent_initrd", lambda: (Path("/dev/null"), False))
    one = types.SimpleNamespace(name="cpu-1", zone="sim-zone")
    monkeypatch.setattr(
        fleet,
        "load_fleet",
        lambda: types.SimpleNamespace(
            mode="vm",
            nodes=[one],
            bm_nodes=[],
            zone_port_ordinal=lambda _z: 0,
            network=types.SimpleNamespace(dhcp=False),
        ),
    )
    monkeypatch.setattr(fleet, "_node_device_ids", lambda _f: {"cpu-1": "dev-1"})

    assert fleet.cmd_init(argparse.Namespace()) == 0
    assert recorded[0] == Step.BUILD_LIVE_IMG
    assert Step.BUILD_IPXE in recorded
    ords = [s for s in recorded if s in progress.BRINGUP_SEQUENCE]
    assert ords == sorted(ords, key=progress.BRINGUP_SEQUENCE.index)


def test_cmd_init_records_error_on_failure_then_reraises(monkeypatch):
    """A failure mid-init must land in fleet-progress.json (so the UI shows 'failed: …'), then propagate."""
    monkeypatch.setattr(fleet, "preflight", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet, "ensure_sudo_cached", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet, "ensure_state_dirs", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet, "assert_discovery_images_served", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet, "build_live_initrd", lambda: (Path("/dev/null"), False))
    monkeypatch.setattr(fleet, "build_bridge_agent_initrd", lambda: (Path("/dev/null"), False))
    monkeypatch.setattr(fleet, "build_grub_binaries", lambda *a, **k: None, raising=False)
    one = types.SimpleNamespace(name="cpu-1", zone="sim-zone")
    monkeypatch.setattr(
        fleet,
        "load_fleet",
        lambda: types.SimpleNamespace(
            mode="vm",
            nodes=[one],
            bm_nodes=[],
            zone_port_ordinal=lambda _z: 0,
            network=types.SimpleNamespace(dhcp=False),
        ),
    )
    monkeypatch.setattr(fleet, "_node_device_ids", lambda _f: {"cpu-1": "dev-1"})

    def boom(*a, **k):
        raise RuntimeError("spoke could not serve brokkr-discovery-dev-1.img")

    monkeypatch.setattr(fleet, "prefetch_node_discovery_initrd", boom)

    with pytest.raises(RuntimeError, match="spoke could not serve"):
        fleet.cmd_init(argparse.Namespace())
    rec = progress.read()
    assert rec is not None and rec["error"] and "spoke could not serve" in rec["error"]
