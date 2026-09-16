from __future__ import annotations

import argparse
import io
import json
import os
import types

import pytest
from local import apply_exec, node_ops
from local import fleet as fleet_mod
from local.schema import Fleet

_NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
_VM_FLEET = {
    "network": _NETWORK,
    "nodes": [
        {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02"},
    ],
}
_BM_FLEET = {
    "network": _NETWORK,
    "nodes": [],
    "baremetal": {
        "iface": "eno1",
        "iface_ip": "10.0.0.5",
        "arch": "amd64",
        "nodes": [
            {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}
        ],
    },
}


def _vm_fleet(dhcp: bool = False) -> Fleet:
    return Fleet.model_validate({**_VM_FLEET, "network": {**_NETWORK, "dhcp": dhcp}})


def _bm_fleet() -> Fleet:
    return Fleet.model_validate(_BM_FLEET)


def _args(node: str, verb: str, as_json: bool = False, purge: bool = False) -> argparse.Namespace:
    ns = argparse.Namespace(node=node, verb=verb, json=as_json)
    if verb == "undefine":
        ns.purge = purge
    return ns


def _stub_post_state(monkeypatch, domain: str = "shut off", ipmi: bool = False, sushy: bool = False):
    monkeypatch.setattr(node_ops, "_virsh_domstate", lambda name: domain)
    monkeypatch.setattr(node_ops, "ipmi_sim_running", lambda name: ipmi)
    monkeypatch.setattr(node_ops, "sushy_running", lambda name: sushy)
    monkeypatch.setattr(node_ops, "ensure_sudo_cached", lambda: None)


def _pin_log_streams(monkeypatch):
    fake_out, fake_err = io.StringIO(), io.StringIO()
    monkeypatch.setattr(node_ops.log, "_stdout", fake_out)
    monkeypatch.setattr(node_ops.log, "_stderr", fake_err)
    return fake_out, fake_err


def test_bare_metal_name_exits_nonzero(monkeypatch):
    monkeypatch.setattr(fleet_mod, "load_fleet", _bm_fleet)
    with pytest.raises(SystemExit) as exc:
        fleet_mod.cmd_node(_args("bm-1", "down"))
    assert "VM nodes only" in str(exc.value)
    assert exc.value.code != 0


def test_missing_fleet_exits(monkeypatch):
    monkeypatch.setattr(fleet_mod, "load_fleet", lambda: None)
    with pytest.raises(SystemExit) as exc:
        fleet_mod.cmd_node(_args("gpu-1", "down"))
    assert "no fleet.yml" in str(exc.value)


def test_resolves_node_by_name_and_index(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(fleet_mod, "load_fleet", _vm_fleet)
    monkeypatch.setattr(fleet_mod, "run_node_verb", lambda fleet, idx, verb, **kw: calls.append((idx, verb)) or 0)
    assert fleet_mod.cmd_node(_args("gpu-2", "up")) == 0
    assert fleet_mod.cmd_node(_args("0", "down")) == 0
    assert calls == [(1, "up"), (0, "down")]


def test_unknown_node_exits(monkeypatch):
    monkeypatch.setattr(fleet_mod, "load_fleet", _vm_fleet)
    with pytest.raises(SystemExit) as exc:
        fleet_mod.cmd_node(_args("nope", "up"))
    assert "unknown node" in str(exc.value)


def test_main_parses_node_subcommand(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(fleet_mod, "load_fleet", _vm_fleet)
    monkeypatch.setattr(fleet_mod, "run_node_verb", lambda fleet, idx, verb, **kw: calls.append((idx, verb, kw)) or 0)
    monkeypatch.setattr(fleet_mod.sys, "argv", ["fleet", "node", "undefine", "gpu-1", "--purge", "--json"])
    assert fleet_mod.main() == 0
    assert calls == [(0, "undefine", {"as_json": True, "purge": True})]


def test_down_runs_teardown_in_order(monkeypatch):
    order: list[tuple] = []

    def fake_virsh(*a, **k):
        order.append(("virsh", a))
        return types.SimpleNamespace(stdout="running\n", returncode=0)

    monkeypatch.setattr(node_ops, "virsh", fake_virsh)
    monkeypatch.setattr(node_ops, "stop_sushy_emulator", lambda name: order.append(("stop_sushy", name)))
    monkeypatch.setattr(node_ops, "purge_ipmi_sim", lambda name: order.append(("purge_ipmi", name)))
    monkeypatch.setattr(node_ops, "remove_lo_alias", lambda ip: order.append(("remove_lo", ip)))

    fleet = _vm_fleet()
    node_ops._down_one_node(fleet, fleet.nodes[0], 0)

    assert order == [
        ("virsh", ("domstate", "gpu-1")),
        ("virsh", ("destroy", "gpu-1")),
        ("stop_sushy", "gpu-1"),
        ("purge_ipmi", "gpu-1"),
        ("remove_lo", "192.168.105.10"),
    ]


def test_down_skips_destroy_when_not_running(monkeypatch):
    order: list[tuple] = []

    def fake_virsh(*a, **k):
        order.append(("virsh", a))
        return types.SimpleNamespace(stdout="shut off\n", returncode=0)

    monkeypatch.setattr(node_ops, "virsh", fake_virsh)
    monkeypatch.setattr(node_ops, "stop_sushy_emulator", lambda name: order.append(("stop_sushy", name)))
    monkeypatch.setattr(node_ops, "purge_ipmi_sim", lambda name: order.append(("purge_ipmi", name)))
    monkeypatch.setattr(node_ops, "remove_lo_alias", lambda ip: order.append(("remove_lo", ip)))

    fleet = _vm_fleet()
    node_ops._down_one_node(fleet, fleet.nodes[1], 1)

    assert order == [
        ("virsh", ("domstate", "gpu-2")),
        ("stop_sushy", "gpu-2"),
        ("purge_ipmi", "gpu-2"),
        ("remove_lo", "192.168.105.11"),
    ]


def test_restart_destroys_preps_console_then_sets_up(monkeypatch):
    order: list = []

    def fake_virsh(*a, **k):
        order.append(("virsh", a))
        return types.SimpleNamespace(stdout="running\n", returncode=0)

    monkeypatch.setattr(node_ops, "virsh", fake_virsh)
    monkeypatch.setattr(fleet_mod, "_prepare_console_logs", lambda fleet: order.append("console_prep"))
    monkeypatch.setattr(fleet_mod, "_setup_one_node", lambda fleet, node, idx: order.append(("setup", node.name, idx)))
    monkeypatch.setattr(fleet_mod, "_make_console_logs_readable", lambda fleet: order.append("console_readable"))

    fleet = _vm_fleet()
    node_ops._restart_one_node(fleet, fleet.nodes[1], 1)

    assert order == [
        ("virsh", ("domstate", "gpu-2")),
        ("virsh", ("destroy", "gpu-2")),
        "console_prep",
        ("setup", "gpu-2", 1),
        "console_readable",
    ]


def _stub_up_pipeline(monkeypatch, order: list, restarted: list[str] | None = None, recovered: list[str] | None = None):
    monkeypatch.setattr(fleet_mod, "ensure_state_dirs", lambda: order.append("state_dirs"))
    monkeypatch.setattr(fleet_mod, "render_xmls", lambda: order.append("render"))
    monkeypatch.setattr(fleet_mod, "grant_bpf", lambda: order.append("bpf_grant"))
    monkeypatch.setattr(node_ops, "write_bootptab", lambda fleet: order.append("bootptab"))
    monkeypatch.setattr(node_ops, "start_socket_vmnet", lambda fleet: order.append("vmnet") or (restarted or []))
    monkeypatch.setattr(node_ops, "ensure_data_plane_bridge", lambda fleet: order.append("bridge"))
    monkeypatch.setattr(node_ops, "_recover_orphaned_nics", lambda r: order.append(("recover", r)) or (recovered or []))
    monkeypatch.setattr(node_ops, "_redefine_and_restart", lambda fleet, n, i: order.append(("redefine", n.name, i)))
    monkeypatch.setattr(fleet_mod, "_prepare_console_logs", lambda fleet: order.append("console_prep"))
    monkeypatch.setattr(fleet_mod, "_setup_one_node", lambda fleet, node, idx: order.append(("setup", node.name)))
    monkeypatch.setattr(fleet_mod, "_make_console_logs_readable", lambda fleet: order.append("console_readable"))


def test_up_runs_preamble_then_setup_on_linux(monkeypatch):
    order: list = []
    _stub_up_pipeline(monkeypatch, order)
    monkeypatch.setattr(node_ops, "host_os", lambda: "linux")

    fleet = _vm_fleet()
    node_ops._up_one_node(fleet, fleet.nodes[0], 0)

    assert order == [
        "state_dirs",
        "render",
        "bridge",
        ("recover", []),
        "console_prep",
        ("setup", "gpu-1"),
        "console_readable",
    ]


def test_up_macos_writes_bootptab_and_grants_bpf_when_dhcp(monkeypatch):
    order: list = []
    _stub_up_pipeline(monkeypatch, order)
    monkeypatch.setattr(node_ops, "host_os", lambda: "macos")

    fleet = _vm_fleet(dhcp=True)
    node_ops._up_one_node(fleet, fleet.nodes[0], 0)

    assert order == [
        "state_dirs",
        "render",
        "bootptab",
        "bpf_grant",
        "vmnet",
        ("recover", []),
        "console_prep",
        ("setup", "gpu-1"),
        "console_readable",
    ]


def test_up_macos_skips_bpf_without_dhcp(monkeypatch):
    order: list = []
    _stub_up_pipeline(monkeypatch, order)
    monkeypatch.setattr(node_ops, "host_os", lambda: "macos")

    fleet = _vm_fleet(dhcp=False)
    node_ops._up_one_node(fleet, fleet.nodes[0], 0)

    assert "bpf_grant" not in order
    assert order[:4] == ["state_dirs", "render", "bootptab", "vmnet"]


def test_up_threads_restarted_daemons_into_nic_recovery(monkeypatch):
    order: list = []
    _stub_up_pipeline(monkeypatch, order, restarted=["gpu-1", "gpu-2"], recovered=["gpu-1", "gpu-2"])
    monkeypatch.setattr(node_ops, "host_os", lambda: "macos")

    fleet = _vm_fleet()
    node_ops._up_one_node(fleet, fleet.nodes[0], 0)

    assert ("recover", ["gpu-1", "gpu-2"]) in order
    assert ("redefine", "gpu-2", 1) in order
    assert ("redefine", "gpu-1", 0) not in order
    assert order.index(("redefine", "gpu-2", 1)) < order.index(("setup", "gpu-1"))


def test_undefine_maps_purge_flag_to_purge_disks(monkeypatch):
    received: list[dict] = []
    monkeypatch.setattr(
        node_ops,
        "_teardown_one_node",
        lambda name, bmc_ip, purge_disks: received.append({"name": name, "bmc_ip": bmc_ip, "purge_disks": purge_disks}),
    )

    fleet = _vm_fleet()
    node_ops._undefine_one_node(fleet, fleet.nodes[0], 0, purge=False)
    node_ops._undefine_one_node(fleet, fleet.nodes[0], 0, purge=True)

    assert received == [
        {"name": "gpu-1", "bmc_ip": "192.168.105.10", "purge_disks": False},
        {"name": "gpu-1", "bmc_ip": "192.168.105.10", "purge_disks": True},
    ]


def test_run_node_verb_plumbs_purge_flag(monkeypatch):
    received: list[bool] = []
    monkeypatch.setattr(node_ops, "_undefine_one_node", lambda fleet, node, idx, purge: received.append(purge))
    _stub_post_state(monkeypatch)
    monkeypatch.setattr(node_ops.log, "info", lambda msg: None)

    assert node_ops.run_node_verb(_vm_fleet(), 0, "undefine", purge=True) == 0
    assert node_ops.run_node_verb(_vm_fleet(), 0, "undefine", purge=False) == 0
    assert received == [True, False]


def _teardown_settings(tmp_path):
    overlay = tmp_path / "overlays"
    nvram = tmp_path / "nvram"
    sushy = tmp_path / "sushy"
    for d in (overlay, nvram, sushy):
        d.mkdir()
    return types.SimpleNamespace(
        state=types.SimpleNamespace(overlay_root=overlay, nvram_root=nvram, sushy_conf_dir=sushy)
    )


def _touch_node_state(s) -> list:
    files = [
        s.state.overlay_root / "gpu-1.img",
        s.state.overlay_root / "gpu-1-d0.img",
        s.state.nvram_root / "gpu-1.fd",
        s.state.sushy_conf_dir / "gpu-1.conf.py",
    ]
    for f in files:
        f.write_text("x")
    return files


def _stub_teardown_calls(monkeypatch) -> list[tuple]:
    calls: list[tuple] = []

    def fake_virsh(*a, **k):
        calls.append(("virsh", a))
        return types.SimpleNamespace(stdout="", returncode=1)

    monkeypatch.setattr(apply_exec, "virsh", fake_virsh)
    monkeypatch.setattr(apply_exec, "stop_sushy_emulator", lambda name: calls.append(("stop_sushy", name)))
    monkeypatch.setattr(apply_exec, "purge_ipmi_sim", lambda name: calls.append(("purge_ipmi", name)))
    monkeypatch.setattr(apply_exec, "remove_lo_alias", lambda ip: calls.append(("remove_lo", ip)))
    monkeypatch.setattr(apply_exec, "host_os", lambda: "linux")
    return calls


def _expected_teardown_calls(undefine_flag: str) -> list[tuple]:
    return [
        ("virsh", ("domstate", "gpu-1")),
        ("virsh", ("undefine", "gpu-1", undefine_flag)),
        ("stop_sushy", "gpu-1"),
        ("purge_ipmi", "gpu-1"),
        ("remove_lo", "192.168.105.10"),
    ]


def test_teardown_one_node_purges_disk_state_by_default(tmp_path, monkeypatch):
    s = _teardown_settings(tmp_path)
    monkeypatch.setattr(apply_exec, "get_settings", lambda: s)
    calls = _stub_teardown_calls(monkeypatch)
    files = _touch_node_state(s)

    apply_exec._teardown_one_node("gpu-1", "192.168.105.10")

    assert calls == _expected_teardown_calls("--nvram")
    assert all(not f.exists() for f in files)


def test_teardown_one_node_keeps_disk_and_nvram_without_purge_bugbot_10d32ee7(tmp_path, monkeypatch):
    s = _teardown_settings(tmp_path)
    monkeypatch.setattr(apply_exec, "get_settings", lambda: s)
    calls = _stub_teardown_calls(monkeypatch)
    files = _touch_node_state(s)

    apply_exec._teardown_one_node("gpu-1", "192.168.105.10", purge_disks=False)

    assert calls == _expected_teardown_calls("--keep-nvram")
    assert all(f.exists() for f in files)


def test_json_mode_prints_camelcase_envelope(monkeypatch, capsys):
    _pin_log_streams(monkeypatch)
    monkeypatch.setattr(node_ops, "_down_one_node", lambda fleet, node, idx: None)
    _stub_post_state(monkeypatch)

    rc = node_ops.run_node_verb(_vm_fleet(), 0, "down", as_json=True)

    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert payload == {
        "name": "gpu-1",
        "verb": "down",
        "ok": True,
        "domain": "shut off",
        "ipmiSim": False,
        "sushy": False,
        "error": None,
    }


def test_json_mode_routes_logs_to_stderr(monkeypatch, capsys):
    fake_out, fake_err = _pin_log_streams(monkeypatch)
    monkeypatch.setattr(node_ops, "_down_one_node", lambda fleet, node, idx: node_ops.log.info("tearing down"))
    _stub_post_state(monkeypatch)

    rc = node_ops.run_node_verb(_vm_fleet(), 0, "down", as_json=True)

    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert payload["ok"] is True
    assert fake_out.getvalue() == ""
    assert "tearing down" in fake_err.getvalue()


def test_json_mode_survives_child_process_stdout_noise(monkeypatch, capfd):
    _pin_log_streams(monkeypatch)

    def noisy(fleet, node, idx):
        os.write(1, b"Formatting 'gpu-1.img', fmt=raw size=42949672960\n")

    monkeypatch.setattr(node_ops, "_up_one_node", noisy)
    _stub_post_state(monkeypatch, domain="running", ipmi=True, sushy=True)

    rc = node_ops.run_node_verb(_vm_fleet(), 0, "up", as_json=True)

    out, err = capfd.readouterr()
    payload = json.loads(out)
    assert rc == 0
    assert payload["ok"] is True
    assert "Formatting" in err
    assert "Formatting" not in out


def test_verb_failure_reports_error_and_exit_one(monkeypatch, capsys):
    _pin_log_streams(monkeypatch)

    def boom(fleet, node, idx):
        raise RuntimeError("destroy blew up")

    monkeypatch.setattr(node_ops, "_down_one_node", boom)
    _stub_post_state(monkeypatch, domain="running", ipmi=True, sushy=True)

    rc = node_ops.run_node_verb(_vm_fleet(), 0, "down", as_json=True)

    payload = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert payload["ok"] is False
    assert "destroy blew up" in payload["error"]
    assert payload["domain"] == "running"
    assert payload["ipmiSim"] is True
    assert payload["sushy"] is True


def test_failure_error_detail_includes_subprocess_stderr(monkeypatch, capsys):
    import subprocess

    _pin_log_streams(monkeypatch)

    def boom(fleet, node, idx):
        raise subprocess.CalledProcessError(1, ["virsh", "start", "gpu-1"], stderr="error: domain is locked\n")

    monkeypatch.setattr(node_ops, "_up_one_node", boom)
    _stub_post_state(monkeypatch)

    rc = node_ops.run_node_verb(_vm_fleet(), 0, "up", as_json=True)

    payload = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert "domain is locked" in payload["error"]


def test_human_mode_success_logs_and_returns_zero(monkeypatch):
    lines: list[str] = []
    monkeypatch.setattr(node_ops.log, "info", lambda msg: lines.append(msg))
    monkeypatch.setattr(node_ops, "_restart_one_node", lambda fleet, node, idx: None)
    _stub_post_state(monkeypatch, domain="running", ipmi=True, sushy=True)

    rc = node_ops.run_node_verb(_vm_fleet(), 1, "restart")

    assert rc == 0
    assert any("gpu-2" in line for line in lines)


def test_human_mode_failure_logs_error_and_returns_one(monkeypatch):
    errors: list[str] = []
    monkeypatch.setattr(node_ops.log, "error", lambda msg: errors.append(msg))

    def boom(fleet, node, idx):
        raise RuntimeError("no xml rendered")

    monkeypatch.setattr(node_ops, "_up_one_node", boom)
    _stub_post_state(monkeypatch)

    rc = node_ops.run_node_verb(_vm_fleet(), 0, "up")

    assert rc == 1
    assert any("no xml rendered" in e for e in errors)
