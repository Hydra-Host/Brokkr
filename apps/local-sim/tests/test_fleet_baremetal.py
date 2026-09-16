from __future__ import annotations

import argparse
import sys
import types

import pytest
from local import applied, verify, verify_baremetal
from local import fleet as fleetmod
from local.fleet import BareMetalOps
from local.schema import Fleet
from local.stores import SimDevice

BM_NODE = {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}
BM_NODE_2 = {"name": "bm-2", "pxe_mac": "00:00:5e:00:53:a2", "bmc_ip": "10.0.0.21", "bmc_mac": "00:00:5e:00:53:c2"}
NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
VALID_BM = {
    "network": NETWORK,
    "defaults": {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"},
    "nodes": [],
    "baremetal": {"iface": "eno1", "iface_ip": "10.0.0.5", "arch": "amd64", "nodes": [dict(BM_NODE)]},
}
VALID_VM = {
    "network": NETWORK,
    "defaults": {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"},
    "nodes": [{"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}],
}


def _bm(overrides=None) -> Fleet:
    data = {**VALID_BM, **(overrides or {})}
    return Fleet.model_validate(data)


def _vm() -> Fleet:
    return Fleet.model_validate(VALID_VM)


def test_bm_preflight_ok_when_iface_up_with_ip_and_docker(monkeypatch):
    monkeypatch.setattr(fleetmod, "iface_is_up", lambda iface: True)
    monkeypatch.setattr(fleetmod, "iface_ipv4", lambda iface: "10.0.0.5")
    monkeypatch.setattr(fleetmod.shutil, "which", lambda tool: "/usr/bin/docker")
    fleetmod.bm_preflight(_bm())


def test_bm_preflight_never_checks_virsh_or_libvirt(monkeypatch):
    monkeypatch.setattr(fleetmod, "iface_is_up", lambda iface: True)
    monkeypatch.setattr(fleetmod, "iface_ipv4", lambda iface: "10.0.0.5")
    monkeypatch.setattr(fleetmod.shutil, "which", lambda tool: "/usr/bin/docker")

    def boom():
        pytest.fail("bm preflight must not probe libvirt")

    monkeypatch.setattr(fleetmod, "_libvirt_probe", boom)
    monkeypatch.setattr(fleetmod, "preflight", boom)
    fleetmod.bm_preflight(_bm())


def test_bm_preflight_fails_when_iface_down(monkeypatch):
    monkeypatch.setattr(fleetmod, "iface_is_up", lambda iface: False)
    monkeypatch.setattr(fleetmod, "iface_ipv4", lambda iface: "10.0.0.5")
    monkeypatch.setattr(fleetmod.shutil, "which", lambda tool: "/usr/bin/docker")
    with pytest.raises(fleetmod.PreflightError):
        fleetmod.bm_preflight(_bm())


def test_bm_preflight_fails_when_iface_has_no_ip(monkeypatch):
    monkeypatch.setattr(fleetmod, "iface_is_up", lambda iface: True)
    monkeypatch.setattr(fleetmod, "iface_ipv4", lambda iface: None)
    monkeypatch.setattr(fleetmod.shutil, "which", lambda tool: "/usr/bin/docker")
    with pytest.raises(fleetmod.PreflightError):
        fleetmod.bm_preflight(_bm())


def test_bm_preflight_fails_when_docker_missing(monkeypatch):
    monkeypatch.setattr(fleetmod, "iface_is_up", lambda iface: True)
    monkeypatch.setattr(fleetmod, "iface_ipv4", lambda iface: "10.0.0.5")
    monkeypatch.setattr(fleetmod.shutil, "which", lambda tool: None)
    with pytest.raises(fleetmod.PreflightError):
        fleetmod.bm_preflight(_bm())


def test_iface_ipv4_parses_ip_json(monkeypatch):
    from local import process_utils

    payload = '[{"ifname":"eno1","addr_info":[{"family":"inet","local":"10.0.0.5"}]}]'
    monkeypatch.setattr(
        process_utils, "run", lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=payload, stderr="")
    )
    assert process_utils.iface_ipv4("eno1") == "10.0.0.5"


def test_iface_ipv4_none_when_command_fails(monkeypatch):
    from local import process_utils

    monkeypatch.setattr(
        process_utils, "run", lambda *a, **k: types.SimpleNamespace(returncode=1, stdout="", stderr="x")
    )
    assert process_utils.iface_ipv4("eno1") is None


def _fake_hubdb(devices):
    class _DB:
        @classmethod
        def from_env(cls):
            return cls()

        def get_sim_devices_by_bmc_ips(self, bmc_ips):
            return [d for d in devices if d.ipmi_ip in bmc_ips]

    return _DB


def test_node_device_ids_joins_bm_nodes_by_bmc_ip(monkeypatch):
    devices = [SimDevice(id="dev-1", name="bm-1", zone_id="z", ipmi_ip="10.0.0.20", primary_ip=None)]
    monkeypatch.setattr(fleetmod, "HubDB", _fake_hubdb(devices))
    out = fleetmod._node_device_ids(_bm({"baremetal": {**VALID_BM["baremetal"], "nodes": [dict(BM_NODE)]}}))
    assert out == {"bm-1": "dev-1"}


def test_node_device_ids_tolerates_unseeded_bm_node(monkeypatch):
    monkeypatch.setattr(fleetmod, "HubDB", _fake_hubdb([]))
    two = {"baremetal": {**VALID_BM["baremetal"], "nodes": [dict(BM_NODE), dict(BM_NODE_2)]}}
    out = fleetmod._node_device_ids(_bm(two))
    assert out == {}


def test_bm_up_skips_render_daemons_and_per_node_setup(monkeypatch):
    forbidden = [
        "render_xmls",
        "per_node_setup",
        "ensure_data_plane_bridge",
        "add_lo_alias",
        "write_bootptab",
        "start_socket_vmnet",
    ]
    for name in forbidden:
        monkeypatch.setattr(fleetmod, name, lambda *a, __n=name, **k: pytest.fail(f"bm up must not call {__n}"))
    BareMetalOps().up(_bm())


def test_cmd_up_bm_writes_applied_manifest_and_no_vm_ops(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "bm_preflight", lambda fleet: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "render_xmls", lambda: pytest.fail("bm must not render XMLs"))
    writes: list[tuple[bool, bool]] = []
    monkeypatch.setattr(applied, "write", lambda f: writes.append((f.has_vm, f.has_bm)) or True)

    rc = fleetmod.cmd_up(argparse.Namespace(supervise=False))
    assert rc == 0
    assert writes == [(False, True)]


def test_verify_cli_defaults_the_probe_budget(monkeypatch):
    seen: list[argparse.Namespace] = []
    monkeypatch.setattr(fleetmod, "cmd_verify", lambda args: seen.append(args) or 0)
    monkeypatch.setattr(sys, "argv", ["local.fleet", "verify"])

    assert fleetmod.main() == 0
    assert seen[0].probe_budget_seconds == 120.0


def test_cmd_verify_forwards_an_explicit_probe_budget_to_the_collector(monkeypatch):
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(applied, "read", lambda: applied.manifest(_bm()))
    monkeypatch.setattr(verify, "host_os", lambda: "linux")
    budgets: list[float] = []
    monkeypatch.setattr(
        verify_baremetal,
        "collect_baremetal_live_state",
        lambda m, *, probe_budget_seconds: (
            budgets.append(probe_budget_seconds) or verify_baremetal.BareMetalLiveState()
        ),
    )

    fleetmod.cmd_verify(argparse.Namespace(heal=False, json=False, probe_budget_seconds=7.5))

    assert budgets == [7.5]


def test_cmd_down_bm_is_noop(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "_vm_down", lambda f: pytest.fail("bm down must not run the VM teardown"))
    assert fleetmod.cmd_down(argparse.Namespace()) == 0


def test_cmd_nuke_bm_clears_manifest_and_sweeps_vm_leftovers(monkeypatch, tmp_path):
    # BM nuke has no VMs of its own but still runs the VM sweep — a fleet switched from VM mode (or
    # a mixed history) can leave orphan libvirt domains + sim state that only _vm_nuke_extras reaps.
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "_vm_down", lambda f: pytest.fail("bm nuke must not run VM down"))
    swept: list[bool] = []
    monkeypatch.setattr(fleetmod, "_vm_nuke_extras", lambda f: swept.append(True))
    cleared: list[bool] = []
    monkeypatch.setattr(applied, "clear", lambda: cleared.append(True))
    assert fleetmod.cmd_nuke(argparse.Namespace()) == 0
    assert cleared == [True]
    assert swept == [True]


def test_cmd_ensure_bridge_bm_skips_data_plane_bridge(monkeypatch):
    monkeypatch.setattr(fleetmod, "host_os", lambda: "linux")
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "ensure_data_plane_bridge", lambda f: pytest.fail("bm must not create br-brokkr"))
    assert fleetmod.cmd_ensure_bridge(argparse.Namespace()) == 0


def test_cmd_ensure_bridge_vm_creates_data_plane_bridge(monkeypatch):
    monkeypatch.setattr(fleetmod, "host_os", lambda: "linux")
    monkeypatch.setattr(fleetmod, "load_fleet", _vm)
    called: list[Fleet] = []
    monkeypatch.setattr(fleetmod, "ensure_data_plane_bridge", lambda f: called.append(f))
    assert fleetmod.cmd_ensure_bridge(argparse.Namespace()) == 0
    assert len(called) == 1


def test_cmd_apply_plane_change_routes_to_op_not_full_rebuild(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "bm_preflight", lambda fleet: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(applied, "read", lambda: applied.manifest(_vm()))
    monkeypatch.setattr(fleetmod, "_full_rebuild", lambda *a, **k: pytest.fail("a plane change must not full-rebuild"))

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=False))
    assert rc == 3


def test_cmd_apply_within_bm_drift_routes_to_op(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    two = {"baremetal": {**VALID_BM["baremetal"], "nodes": [dict(BM_NODE), dict(BM_NODE_2)]}}
    monkeypatch.setattr(fleetmod, "load_fleet", lambda: _bm(two))
    monkeypatch.setattr(fleetmod, "bm_preflight", lambda fleet: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(applied, "read", lambda: applied.manifest(_bm()))
    monkeypatch.setattr(fleetmod, "_full_rebuild", lambda *a, **k: pytest.fail("bm drift must not full-rebuild"))

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=False))
    assert rc == 3


def test_cmd_apply_bm_in_sync_commits_and_returns_zero(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "bm_preflight", lambda fleet: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(applied, "read", lambda: applied.manifest(_bm()))
    monkeypatch.setattr(applied, "write", lambda f: True)

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=False))
    assert rc == 0
