import local.config as cfg
import local.fleet as fleet_mod
import local.network as network_mod
import pytest
from local.fleet import resolve_index
from local.schema import Fleet

_FLEET = {
    "network": {
        "name": "brokkr-net",
        "cidr": "192.168.200.0/24",
        "domain": "sim.local",
        "bmc_cidr": "192.168.105.0/24",
    },
    "nodes": [
        {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02"},
    ],
}


def _fleet() -> Fleet:
    return Fleet.model_validate(_FLEET)


def test_numeric_in_range():
    assert resolve_index("1", _fleet()) == 1


def test_numeric_out_of_range_exits_cleanly():
    with pytest.raises(SystemExit) as exc:
        resolve_index("5", _fleet())
    assert "out of range" in str(exc.value)


def test_name_match():
    assert resolve_index("gpu-2", _fleet()) == 1


def test_unknown_name_exits():
    with pytest.raises(SystemExit) as exc:
        resolve_index("nope", _fleet())
    assert "unknown node" in str(exc.value)


def test_none_fleet_exits():
    with pytest.raises(SystemExit) as exc:
        resolve_index("0", None)
    assert "no fleet.yml" in str(exc.value)


def test_records_failure_surfaces_subprocess_stderr(monkeypatch):
    import subprocess

    captured: list[str] = []
    monkeypatch.setattr(fleet_mod.progress, "error", lambda msg: captured.append(msg))

    @fleet_mod._records_failure("fleet up failed")
    def boom():
        raise subprocess.CalledProcessError(
            1,
            ["virsh", "net-start", "brokkr-data"],
            stderr="error: Network is already in use by interface virbr4\n",
        )

    with pytest.raises(subprocess.CalledProcessError):
        boom()

    assert len(captured) == 1
    assert captured[0].startswith("fleet up failed:")
    assert "Network is already in use by interface virbr4" in captured[0]


def test_records_failure_without_stderr_falls_back_to_str(monkeypatch):
    captured: list[str] = []
    monkeypatch.setattr(fleet_mod.progress, "error", lambda msg: captured.append(msg))

    @fleet_mod._records_failure("fleet up failed")
    def boom():
        raise RuntimeError("plain failure")

    with pytest.raises(RuntimeError):
        boom()

    assert captured == ["fleet up failed: plain failure"]


def test_ensure_data_plane_bridge_calls_bridge_ensure_with_gateway(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(network_mod, "sudo_priv", lambda *a, **k: calls.append(a))

    fleet_mod.ensure_data_plane_bridge(_fleet())

    assert calls == [
        ("bridge-ensure", "br-brokkr", "192.168.200.1", "24"),
        ("bridge-nat", "br-brokkr", "192.168.200.0/24"),
    ]


def test_grant_bpf_invokes_sim_priv(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(fleet_mod, "_bpf_warned", False, raising=False)
    monkeypatch.setattr(fleet_mod, "sudo_priv", lambda *a, **k: calls.append(a))
    fleet_mod.grant_bpf()
    assert ("bpf-grant",) in calls


def test_revoke_bpf_invokes_sim_priv_best_effort(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(fleet_mod, "sudo_priv", lambda *a, **k: calls.append((a, k)))
    fleet_mod.revoke_bpf()
    assert calls == [(("bpf-revoke",), {"check": False})]


def test_grant_bpf_leaves_warn_flag_unset_when_grant_fails(monkeypatch):
    monkeypatch.setattr(fleet_mod, "_bpf_warned", False, raising=False)

    def boom(*_a, **_k):
        raise RuntimeError("sim-priv not installed")

    monkeypatch.setattr(fleet_mod, "sudo_priv", boom)
    with pytest.raises(RuntimeError):
        fleet_mod.grant_bpf()
    assert fleet_mod._bpf_warned is False


def _stub_macos_vm_lifecycle(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(fleet_mod, "sudo_priv", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(fleet_mod, "host_os", lambda: "macos")
    monkeypatch.setattr(fleet_mod.progress, "set", lambda *a, **k: None)
    for fn in (
        "render_xmls",
        "write_bootptab",
        "add_lo_alias",
        "_recover_orphaned_nics",
        "_prepare_console_logs",
        "per_node_setup",
        "_make_console_logs_readable",
        "remove_bootptab",
        "stop_socket_vmnet",
    ):
        monkeypatch.setattr(fleet_mod, fn, lambda *a, **k: None, raising=False)
    monkeypatch.setattr(fleet_mod, "start_socket_vmnet", lambda *a, **k: [])
    monkeypatch.setattr(fleet_mod, "_bpf_warned", False, raising=False)
    return calls


def _dhcp_fleet(dhcp: bool) -> Fleet:
    return Fleet.model_validate({**_FLEET, "network": {**_FLEET["network"], "dhcp": dhcp}})


def test_vm_up_grants_bpf_when_dhcp_enabled(monkeypatch):
    calls = _stub_macos_vm_lifecycle(monkeypatch)
    fleet_mod.VmOps().up(_dhcp_fleet(True))
    assert ("bpf-grant",) in calls


def test_vm_up_skips_bpf_grant_when_dhcp_disabled(monkeypatch):
    calls = _stub_macos_vm_lifecycle(monkeypatch)
    fleet_mod.VmOps().up(_dhcp_fleet(False))
    assert ("bpf-grant",) not in calls


def test_vm_down_revokes_bpf_unconditionally_on_macos(monkeypatch):
    calls = _stub_macos_vm_lifecycle(monkeypatch)
    fleet_mod._vm_down(None)
    assert ("bpf-revoke",) in calls


class _RecordingLog:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def info(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass

    def skip(self, msg: str) -> None:
        pass

    def detail(self, msg: str) -> None:
        pass

    def success(self, msg: str) -> None:
        pass


@pytest.fixture
def rec_log(monkeypatch):
    rec = _RecordingLog()
    monkeypatch.setattr(fleet_mod, "log", rec)
    return rec


def _passthrough_fleet() -> Fleet:
    nodes = [{**_FLEET["nodes"][0], "passthrough": ["0000:01:00.0"]}]
    return Fleet.model_validate({**_FLEET, "nodes": nodes})


def test_no_degradation_report_under_hardware_acceleration(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "kvm")
    fleet_mod.report_accel_degradation()
    assert rec_log.warnings == []


def test_degradation_report_copies_the_canonical_block_verbatim(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "tcg")
    fleet_mod.report_accel_degradation()
    blob = "\n".join(rec_log.warnings)
    assert fleet_mod.TCG_DEGRADATION_PREAMBLE in blob
    assert fleet_mod.TCG_DEGRADATION_CAUSES in blob
    assert fleet_mod.TCG_DEGRADATION_FORCED not in blob


def test_forced_degradation_replaces_the_cause_block(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "tcg")
    monkeypatch.setenv("LOCAL_ACCEL", "tcg")
    cfg.get_settings.cache_clear()

    fleet_mod.report_accel_degradation()

    blob = "\n".join(rec_log.warnings)
    assert fleet_mod.TCG_DEGRADATION_PREAMBLE in blob
    assert fleet_mod.TCG_DEGRADATION_FORCED in blob
    assert fleet_mod.TCG_DEGRADATION_CAUSES not in blob


def test_brief_degradation_report_is_one_sentence(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "tcg")
    fleet_mod.report_accel_degradation(brief=True)
    assert rec_log.warnings == [fleet_mod.TCG_DEGRADATION_BRIEF]


def test_passthrough_under_tcg_warns_and_does_not_raise(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "tcg")
    fleet_mod.report_accel_degradation(_passthrough_fleet())
    assert any("passthrough" in w for w in rec_log.warnings)


def test_no_passthrough_warning_without_a_passthrough_node(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "tcg")
    fleet_mod.report_accel_degradation(_fleet())
    assert not any("passthrough" in w for w in rec_log.warnings)


def _green_host(monkeypatch, tmp_path):
    stub = tmp_path / "stub"
    stub.write_text("")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "sushy-emulator").write_text("")
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(stub))
    monkeypatch.setenv("LOCAL_SOCKET_VMNET_BIN", str(stub))
    monkeypatch.setenv("LOCAL_IPMI_SIM_BIN", str(stub))
    monkeypatch.setenv("LOCAL_PYTHON_BIN", str(bindir))
    cfg.get_settings.cache_clear()
    monkeypatch.setattr("shutil.which", lambda _t: "/usr/bin/stub")
    monkeypatch.setattr(fleet_mod, "host_os", lambda: "macos")
    monkeypatch.setattr(fleet_mod, "_libvirt_probe", lambda: (True, ""))


def test_preflight_reports_degradation_without_blocking(monkeypatch, tmp_path, rec_log):
    _green_host(monkeypatch, tmp_path)
    monkeypatch.setattr(fleet_mod, "detect_accel", lambda: "tcg")

    fleet_mod.preflight()

    assert any(fleet_mod.TCG_DEGRADATION_PREAMBLE in w for w in rec_log.warnings)
