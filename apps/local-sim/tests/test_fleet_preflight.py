from __future__ import annotations

import subprocess

import pytest
from local import fleet as fleet_mod


class _RecordingLog:
    def __init__(self) -> None:
        self.warnings: list[str] = []
        self.errors: list[str] = []

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def info(self, msg: str) -> None:
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


def _completed(returncode: int, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr=stderr)


def test_libvirt_probe_returns_the_stderr(monkeypatch):
    monkeypatch.setattr(fleet_mod, "run", lambda *a, **k: _completed(1, stderr="error: Permission denied\n"))
    reachable, err = fleet_mod._libvirt_probe()
    assert reachable is False
    assert err == "error: Permission denied"


def test_libvirt_probe_reports_reachable_on_exit_zero(monkeypatch):
    monkeypatch.setattr(fleet_mod, "run", lambda *a, **k: _completed(0))
    assert fleet_mod._libvirt_probe() == (True, "")


def test_libvirt_probe_asks_virsh_for_the_domain_list(monkeypatch):
    seen: list[tuple] = []

    def fake_run(*cmd, **kw):
        seen.append(cmd)
        return _completed(0)

    monkeypatch.setattr(fleet_mod, "run", fake_run)
    fleet_mod._libvirt_probe()
    assert seen[0][0] == "virsh"
    assert seen[0][-1] == "list"


def test_permission_denied_names_the_libvirt_group_not_a_stopped_daemon():
    issue = fleet_mod._libvirt_issue("error: failed to connect to the socket: Permission denied", is_mac=False)
    assert "libvirt" in issue
    assert "permission denied" in issue.lower()
    assert "sudo systemctl start libvirtd" not in issue


def test_socket_missing_yields_the_start_hint():
    err = "error: Failed to connect socket to '/var/run/libvirt/virtqemud-sock': No such file or directory"
    issue = fleet_mod._libvirt_issue(err, is_mac=False)
    assert "sudo systemctl start libvirtd" in issue
    assert "No such file or directory" in issue


def test_socket_missing_yields_the_brew_hint_on_macos():
    issue = fleet_mod._libvirt_issue("error: No such file or directory", is_mac=True)
    assert "brew services start libvirt" in issue


def test_preflight_error_is_not_a_systemexit():
    assert issubclass(fleet_mod.PreflightError, RuntimeError)
    assert not issubclass(fleet_mod.PreflightError, SystemExit)


def test_preflight_raises_preflight_error_listing_the_issues(monkeypatch, rec_log):
    monkeypatch.setattr(fleet_mod, "host_os", lambda: "macos")
    monkeypatch.setattr(fleet_mod, "_libvirt_probe", lambda: (False, "error: Permission denied"))
    monkeypatch.setattr(fleet_mod, "report_accel_degradation", lambda *a, **k: None)

    with pytest.raises(fleet_mod.PreflightError) as exc:
        fleet_mod.preflight()

    assert "libvirt" in str(exc.value)
    assert rec_log.errors


def test_bm_preflight_raises_preflight_error(monkeypatch, rec_log):
    import types

    monkeypatch.setattr(fleet_mod, "iface_is_up", lambda _i: False)
    monkeypatch.setattr(fleet_mod, "iface_ipv4", lambda _i: None)
    fleet = types.SimpleNamespace(baremetal_raw=types.SimpleNamespace(iface="eno1"))

    with pytest.raises(fleet_mod.PreflightError):
        fleet_mod.bm_preflight(fleet)


def test_preflight_error_reaches_the_progress_stamp(monkeypatch):
    captured: list[str] = []
    monkeypatch.setattr(fleet_mod.progress, "error", lambda msg: captured.append(msg))

    @fleet_mod._records_failure("fleet up failed")
    def boom():
        raise fleet_mod.PreflightError("preflight failed: libvirt not reachable")

    with pytest.raises(fleet_mod.PreflightError):
        boom()

    assert captured == ["fleet up failed: preflight failed: libvirt not reachable"]


@pytest.mark.parametrize("message", ["1", "", "   "])
def test_records_failure_never_stamps_a_numeric_or_empty_detail(monkeypatch, message):
    captured: list[str] = []
    monkeypatch.setattr(fleet_mod.progress, "error", lambda msg: captured.append(msg))

    @fleet_mod._records_failure("fleet up failed")
    def boom():
        raise RuntimeError(message)

    with pytest.raises(RuntimeError):
        boom()

    assert captured == ["fleet up failed: see the fleet:init log for the failing step"]


def test_main_maps_preflight_error_to_rc_1_and_leaves_logging_to_the_raiser(monkeypatch, rec_log):
    def boom(_args):
        raise fleet_mod.PreflightError("preflight failed: libvirt not reachable")

    monkeypatch.setattr("sys.argv", ["fleet", "up"])
    monkeypatch.setattr(fleet_mod, "cmd_up", boom)

    assert fleet_mod.main() == 1
    assert not any("libvirt not reachable" in e for e in rec_log.errors)
