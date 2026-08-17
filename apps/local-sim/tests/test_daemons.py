from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from local import daemons


def _fake_settings(tmp_path: Path) -> types.SimpleNamespace:
    root = tmp_path / "state-root"
    return types.SimpleNamespace(
        state=types.SimpleNamespace(
            root=root,
            ipmi_sim_dir_for=lambda node: root / "state/ipmi-sim" / node,
        ),
        paths=types.SimpleNamespace(
            ipmi_sim=tmp_path / "opt" / "ipmi_sim",
            sim_priv_bin=tmp_path / "opt" / "brokkr-sim-priv",
        ),
    )


def _node(name: str = "gpu-1") -> types.SimpleNamespace:
    return types.SimpleNamespace(
        name=name,
        ipmi_mac="52:54:00:bb:00:01",
        bmc=types.SimpleNamespace(username="admin", password="secret"),
    )


def test_registered_names_lists_dirs_only(tmp_path, monkeypatch):
    s = _fake_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    base = s.state.root / "state/ipmi-sim"
    (base / "gpu-1").mkdir(parents=True)
    (base / "cpu-1").mkdir(parents=True)
    (base / "stray.txt").write_text("x")

    assert sorted(daemons.ipmi_sim_registered_names()) == ["cpu-1", "gpu-1"]


def test_registered_names_empty_when_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(daemons, "get_settings", lambda: _fake_settings(tmp_path))
    assert daemons.ipmi_sim_registered_names() == []


def test_start_ipmi_sim_renders_lanconf_and_launches_via_helper(tmp_path, monkeypatch):
    s = _fake_settings(tmp_path)
    s.paths.ipmi_sim.parent.mkdir(parents=True)
    s.paths.ipmi_sim.write_text("#!/bin/sh\n")
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    monkeypatch.setattr(daemons, "libvirt_uri_for_root", lambda: "qemu:///system")
    monkeypatch.setattr(daemons, "_virsh_bin", lambda: "/usr/bin/virsh")

    state = {"up": False}
    monkeypatch.setattr(daemons, "ipmi_sim_running", lambda name: state["up"])
    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        state["up"] = True
        return object()

    monkeypatch.setattr(daemons.subprocess, "Popen", fake_popen)

    daemons.start_ipmi_sim(_node("gpu-1"), "192.168.105.10", console_port=9300)

    lan = (s.state.ipmi_sim_dir_for("gpu-1") / "lan.conf").read_text()
    assert "addr 192.168.105.10 623" in lan
    assert "ipmi-sim-chassisctl.py /usr/bin/virsh gpu-1 qemu:///system" in lan
    assert 'sol "telnet:127.0.0.1:9300" 115200' in lan
    assert '"admin"' in lan and '"secret"' in lan

    args = captured["args"]
    assert isinstance(args, list)
    assert args == ["sudo", str(s.paths.sim_priv_bin), "ipmi-launch", str(s.state.ipmi_sim_dir_for("gpu-1"))]


def _vmnet_settings(tmp_path: Path) -> types.SimpleNamespace:
    run = tmp_path / "run"
    return types.SimpleNamespace(
        state=types.SimpleNamespace(
            run_dir=run,
            socket_vmnet_sock_for=lambda node: run / f"socket_vmnet.{node}.sock",
            socket_vmnet_pid_for=lambda node: run / f"socket_vmnet.{node}.pid",
            socket_vmnet_log_for=lambda node: run / f"socket_vmnet.{node}.log",
        ),
        paths=types.SimpleNamespace(socket_vmnet_bin=Path("/opt/socket_vmnet/bin/socket_vmnet")),
    )


def _capture_spawn(monkeypatch, s):
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        return object()

    monkeypatch.setattr(daemons.subprocess, "Popen", fake_popen)
    return captured


def test_spawn_socket_vmnet_classic_mode_first(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    captured = _capture_spawn(monkeypatch, s)
    daemons._spawn_socket_vmnet("gpu-1", "192.168.200.1", "192.168.200.254")
    args = captured["args"]
    assert args[:3] == ["sudo", str(s.paths.socket_vmnet_bin), "--vmnet-mode=shared"]
    assert "--vmnet-disable-dhcp" not in args
    assert "--vmnet-gateway=192.168.200.1" in args
    assert args[-1] == str(s.state.socket_vmnet_sock_for("gpu-1"))


def test_spawn_owner_creates_disable_dhcp_network_and_serializes(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    captured = _capture_spawn(monkeypatch, s)
    daemons._spawn_owner("192.168.200.1", "192.168.200.254")
    args = captured["args"]
    assert args[:3] == ["sudo", str(s.paths.socket_vmnet_bin), "--vmnet-mode=shared"]
    assert "--vmnet-disable-dhcp" in args
    assert f"--vmnet-serialize-to={daemons._shared_blob_path()}" in args
    assert not any(str(a).endswith(".sock") for a in args)


def test_spawn_joiner_attaches_to_shared_network(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    captured = _capture_spawn(monkeypatch, s)
    daemons._spawn_joiner("gpu-1")
    args = captured["args"]
    assert args[:3] == ["sudo", str(s.paths.socket_vmnet_bin), "--vmnet-mode=shared"]
    assert f"--vmnet-join-from={daemons._shared_blob_path()}" in args
    assert "--vmnet-disable-dhcp" not in args
    assert args[-1] == str(s.state.socket_vmnet_sock_for("gpu-1"))


def _routing_fleet(dhcp: bool, node_names=("gpu-1", "cpu-1")) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        network=types.SimpleNamespace(cidr="192.168.200.0/24", dhcp=dhcp),
        nodes=[types.SimpleNamespace(name=n) for n in node_names],
    )


def test_start_socket_vmnet_routes_to_shared_network_on_macos_26(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    monkeypatch.setattr(daemons, "macos_major", lambda: 26)
    calls: dict[str, object] = {}

    def fake_shared(fleet, gateway, dhcp_end):
        calls.update(gateway=gateway, dhcp_end=dhcp_end)
        return ["gpu-1", "cpu-1"]

    monkeypatch.setattr(daemons, "_start_shared_network", fake_shared)
    monkeypatch.setattr(daemons, "_spawn_socket_vmnet", lambda *a: calls.setdefault("classic_spawned", True))

    started = daemons.start_socket_vmnet(_routing_fleet(dhcp=True))

    assert started == ["gpu-1", "cpu-1"]
    assert calls["gateway"] == "192.168.200.1"
    assert calls["dhcp_end"] == "192.168.200.254"
    assert "classic_spawned" not in calls


def test_start_socket_vmnet_falls_back_to_classic_below_macos_26(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    monkeypatch.setattr(daemons, "macos_major", lambda: 15)
    monkeypatch.setattr(daemons, "_socket_vmnet_running", lambda name: False)
    monkeypatch.setattr(daemons, "_wait_for_socks", lambda pending: None)
    shared = {"called": False}
    monkeypatch.setattr(daemons, "_start_shared_network", lambda *a: shared.update(called=True))
    spawned: list[str] = []
    monkeypatch.setattr(daemons, "_spawn_socket_vmnet", lambda node, gw, end: spawned.append(node))

    started = daemons.start_socket_vmnet(_routing_fleet(dhcp=True))

    assert shared["called"] is False
    assert spawned == ["gpu-1", "cpu-1"]
    assert started == ["gpu-1", "cpu-1"]


def test_start_socket_vmnet_classic_when_dhcp_disabled(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)

    def _must_not_call():
        raise AssertionError("macos_major() consulted with dhcp disabled")

    monkeypatch.setattr(daemons, "macos_major", _must_not_call)
    monkeypatch.setattr(daemons, "_socket_vmnet_running", lambda name: False)
    monkeypatch.setattr(daemons, "_wait_for_socks", lambda pending: None)
    monkeypatch.setattr(daemons, "_start_shared_network", lambda *a: (_ for _ in ()).throw(AssertionError("shared")))
    spawned: list[str] = []
    monkeypatch.setattr(daemons, "_spawn_socket_vmnet", lambda node, gw, end: spawned.append(node))

    started = daemons.start_socket_vmnet(_routing_fleet(dhcp=False))

    assert spawned == ["gpu-1", "cpu-1"]
    assert started == ["gpu-1", "cpu-1"]


def test_wait_for_socks_returns_when_all_present(tmp_path):
    a = tmp_path / "a.sock"
    b = tmp_path / "b.sock"
    a.write_text("")
    b.write_text("")
    daemons._wait_for_socks({"gpu-1": a, "cpu-1": b})


def test_wait_for_socks_raises_on_timeout(tmp_path, monkeypatch):
    times = iter([0.0, 100.0])
    monkeypatch.setattr(daemons.time, "monotonic", lambda: next(times, 100.0))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)
    with pytest.raises(RuntimeError, match="did not create sockets within 15s"):
        daemons._wait_for_socks({"gpu-1": tmp_path / "never.sock"})


def test_wait_for_socks_raises_early_on_owner_crash(tmp_path, monkeypatch):
    times = iter([0.0, 1.0])
    monkeypatch.setattr(daemons.time, "monotonic", lambda: next(times, 1.0))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)
    with pytest.raises(RuntimeError, match="owner died while waiting for joiner sockets"):
        daemons._wait_for_socks(
            {"gpu-1": tmp_path / "never.sock"},
            owner_check=lambda: False,
        )


def test_wait_for_socks_owner_check_not_called_when_none(tmp_path, monkeypatch):
    times = iter([0.0, 100.0])
    monkeypatch.setattr(daemons.time, "monotonic", lambda: next(times, 100.0))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)
    with pytest.raises(RuntimeError, match="did not create sockets within 15s"):
        daemons._wait_for_socks({"gpu-1": tmp_path / "never.sock"}, owner_check=None)


def test_wait_for_socks_succeeds_with_owner_alive(tmp_path):
    sock = tmp_path / "a.sock"
    sock.write_text("")
    daemons._wait_for_socks({"gpu-1": sock}, owner_check=lambda: True)


def test_start_shared_network_happy_path(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    blob = tmp_path / "shared.blob"
    blob.write_text("")
    monkeypatch.setattr(daemons, "_shared_blob_path", lambda: blob)
    monkeypatch.setattr(daemons, "_socket_vmnet_running", lambda name: name == "owner")
    monkeypatch.setattr(daemons, "_spawn_owner", lambda gw, end: None)
    joined: list[str] = []
    monkeypatch.setattr(daemons, "_spawn_joiner", lambda node: joined.append(node))
    monkeypatch.setattr(daemons, "_wait_for_socks", lambda pending, **kw: None)
    hostip: dict[str, object] = {}
    monkeypatch.setattr(daemons, "sudo_priv", lambda *a: hostip.setdefault("args", a))

    started = daemons._start_shared_network(_routing_fleet(dhcp=True), "192.168.200.1", "192.168.200.254")

    assert started == ["gpu-1", "cpu-1"]
    assert joined == ["gpu-1", "cpu-1"]
    assert hostip["args"] == ("vmnet-hostip", "192.168.200.1", "255.255.255.0")


def test_start_shared_network_raises_when_blob_never_written(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    monkeypatch.setattr(daemons, "_shared_blob_path", lambda: tmp_path / "never.blob")
    monkeypatch.setattr(daemons, "_socket_vmnet_running", lambda name: True)
    monkeypatch.setattr(daemons, "_spawn_owner", lambda gw, end: None)
    times = iter([0.0, 100.0])
    monkeypatch.setattr(daemons.time, "monotonic", lambda: next(times, 100.0))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)

    with pytest.raises(RuntimeError, match="did not write the shared-network blob within 15s"):
        daemons._start_shared_network(_routing_fleet(dhcp=True), "192.168.200.1", "192.168.200.254")


def test_start_shared_network_raises_when_owner_exits_before_blob(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    monkeypatch.setattr(daemons, "_shared_blob_path", lambda: tmp_path / "never.blob")
    monkeypatch.setattr(daemons, "_socket_vmnet_running", lambda name: False)
    monkeypatch.setattr(daemons, "_spawn_owner", lambda gw, end: None)
    times = iter([0.0, 1.0])
    monkeypatch.setattr(daemons.time, "monotonic", lambda: next(times, 1.0))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)

    with pytest.raises(RuntimeError, match="exited before writing the shared-network blob"):
        daemons._start_shared_network(_routing_fleet(dhcp=True), "192.168.200.1", "192.168.200.254")


def test_start_shared_network_raises_when_owner_exits_after_blob(tmp_path, monkeypatch):
    s = _vmnet_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    blob = tmp_path / "shared.blob"
    blob.write_text("")
    monkeypatch.setattr(daemons, "_shared_blob_path", lambda: blob)
    call_count = {"n": 0}

    def owner_alive_then_dead(name: str) -> bool:
        if name != "owner":
            return False
        call_count["n"] += 1
        return call_count["n"] <= 1

    monkeypatch.setattr(daemons, "_socket_vmnet_running", owner_alive_then_dead)
    monkeypatch.setattr(daemons, "_spawn_owner", lambda gw, end: None)

    with pytest.raises(RuntimeError, match="exited immediately after writing the shared-network blob"):
        daemons._start_shared_network(_routing_fleet(dhcp=True), "192.168.200.1", "192.168.200.254")


def _sushy_settings(tmp_path: Path) -> types.SimpleNamespace:
    run = tmp_path / "run"
    conf = tmp_path / "conf"
    run.mkdir(parents=True, exist_ok=True)
    conf.mkdir(parents=True, exist_ok=True)
    return types.SimpleNamespace(state=types.SimpleNamespace(run_dir=run, sushy_conf_dir=conf))


def test_stop_sushy_skips_kill_on_identity_mismatch(tmp_path, monkeypatch):
    s = _sushy_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    pidf = daemons.sushy_pidfile("gpu-1")
    pidf.write_text("4242")
    monkeypatch.setattr(daemons, "_sushy_pids", lambda n: set())
    killed: list = []
    monkeypatch.setattr(daemons.os, "kill", lambda pid, sig: killed.append((pid, sig)))

    daemons.stop_sushy_emulator("gpu-1")

    assert killed == []
    assert not pidf.exists()


def test_stop_sushy_signals_and_waits_for_exit(tmp_path, monkeypatch):
    s = _sushy_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    pidf = daemons.sushy_pidfile("gpu-1")
    pidf.write_text("4242")
    pids = iter([{4242}, set()])
    monkeypatch.setattr(daemons, "_sushy_pids", lambda n: next(pids, set()))
    killed: list = []
    monkeypatch.setattr(daemons.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)

    daemons.stop_sushy_emulator("gpu-1")

    assert killed == [(4242, daemons.signal.SIGTERM)]
    assert not pidf.exists()


def test_stop_sushy_escalates_to_sigkill_when_process_lingers(tmp_path, monkeypatch):
    s = _sushy_settings(tmp_path)
    monkeypatch.setattr(daemons, "get_settings", lambda: s)
    pidf = daemons.sushy_pidfile("gpu-1")
    pidf.write_text("4242")
    monkeypatch.setattr(daemons, "_sushy_pids", lambda n: {4242})
    killed: list = []
    monkeypatch.setattr(daemons.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr(daemons.time, "sleep", lambda *_: None)

    daemons.stop_sushy_emulator("gpu-1")

    assert (4242, daemons.signal.SIGTERM) in killed
    assert (4242, daemons.signal.SIGKILL) in killed
    assert not pidf.exists()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
