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
        "wait_for_spoke",
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
    monkeypatch.setattr(fleet, "wait_for_spoke", lambda *a, **k: True, raising=False)
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


def test_accel_key_survives_a_following_set_call():
    progress.set(Step.RENDER, accel="tcg")
    assert progress.read()["accel"] == "tcg"

    progress.set(Step.DAEMONS)
    assert progress.read()["accel"] == "tcg"


def test_accel_key_is_none_until_a_writer_supplies_it():
    progress.set(Step.RENDER)
    assert progress.read()["accel"] is None


def test_an_explicit_accel_overrides_the_carried_value():
    progress.set(Step.RENDER, accel="tcg")
    progress.set(Step.DAEMONS, accel="kvm")
    assert progress.read()["accel"] == "kvm"


def test_accel_forced_survives_a_following_set_call():
    progress.set(Step.RENDER, accel="tcg", accel_forced=True)
    assert progress.read()["accelForced"] is True

    progress.set(Step.DAEMONS)
    assert progress.read()["accelForced"] is True


def test_accel_forced_is_none_until_a_writer_supplies_it():
    progress.set(Step.RENDER)
    assert progress.read()["accelForced"] is None


def test_cmd_init_stamps_the_accelerator_on_its_first_record(monkeypatch):
    calls: list[tuple[Step, dict]] = []
    monkeypatch.setattr(progress, "set", lambda step, **k: calls.append((step, k)))
    monkeypatch.setattr(fleet, "detect_accel", lambda: "tcg")
    monkeypatch.setattr(fleet, "accel_forced", lambda: True)
    stubbed = (
        "preflight",
        "ensure_sudo_cached",
        "ensure_state_dirs",
        "wait_for_spoke",
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
    assert calls[0][0] == Step.BUILD_LIVE_IMG
    assert calls[0][1]["accel"] == "tcg"
    assert calls[0][1]["accel_forced"] is True


def test_vm_ops_up_stamps_the_accelerator_on_its_first_record(monkeypatch):
    calls: list[tuple[Step, dict]] = []
    monkeypatch.setattr(progress, "set", lambda step, **k: calls.append((step, k)))
    monkeypatch.setattr(fleet, "detect_accel", lambda: "tcg")
    monkeypatch.setattr(fleet, "accel_forced", lambda: False)
    for n in (
        "render_xmls",
        "write_bootptab",
        "grant_bpf",
        "ensure_data_plane_bridge",
        "add_lo_alias",
        "_recover_orphaned_nics",
        "_prepare_console_logs",
        "per_node_setup",
        "_make_console_logs_readable",
    ):
        monkeypatch.setattr(fleet, n, lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet, "start_socket_vmnet", lambda *a, **k: [], raising=False)
    monkeypatch.setattr(fleet, "effective_bmc_ip", lambda *a, **k: "127.0.0.1", raising=False)
    one = types.SimpleNamespace(name="cpu-1", zone="sim-zone")
    target = types.SimpleNamespace(
        mode="vm",
        nodes=[one],
        network=types.SimpleNamespace(dhcp=False, bmc_cidr="192.168.105.0/24"),
    )

    fleet.VmOps().up(target)

    assert calls[0][0] == Step.RENDER
    assert calls[0][1]["accel"] == "tcg"
    assert calls[0][1]["accel_forced"] is False
