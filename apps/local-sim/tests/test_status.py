from __future__ import annotations

import subprocess

from local import status
from local.status import _ipmi_sim_status, _virsh_domstate, fleet_ready


def _completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_ready_when_all_domains_running():
    states = {"gpu-1": "running", "gpu-2": "running"}
    assert fleet_ready(["gpu-1", "gpu-2"], states.__getitem__) is True


def test_not_ready_when_any_domain_not_running():
    states = {"gpu-1": "running", "gpu-2": "shut off"}
    assert fleet_ready(["gpu-1", "gpu-2"], states.__getitem__) is False


def test_not_ready_when_domain_undefined():
    assert fleet_ready(["gpu-1"], lambda _name: "undefined") is False


def test_vacuously_ready_with_no_nodes():
    assert fleet_ready([], lambda _name: "running") is True


def test_virsh_domstate_uses_wrapper(monkeypatch):
    calls = {}

    def fake_virsh(*args, **kw):
        calls["args"] = args
        calls["kw"] = kw
        return _completed(0, stdout="running\n")

    monkeypatch.setattr(status.process_utils, "virsh", fake_virsh)
    assert _virsh_domstate("gpu-1") == "running"
    assert calls["args"] == ("domstate", "gpu-1")
    assert calls["kw"]["capture"] is True
    assert calls["kw"]["check"] is False


def test_virsh_domstate_undefined_on_nonzero(monkeypatch):
    monkeypatch.setattr(status.process_utils, "virsh", lambda *a, **k: _completed(1, stderr="boom"))
    assert _virsh_domstate("gpu-1") == "undefined"


def test_ipmi_sim_status_running(monkeypatch):
    from local import daemons

    monkeypatch.setattr(daemons, "ipmi_sim_running", lambda name: True)
    assert _ipmi_sim_status("gpu-1") == "running"


def test_ipmi_sim_status_stopped(monkeypatch):
    from local import daemons

    monkeypatch.setattr(daemons, "ipmi_sim_running", lambda name: False)
    assert _ipmi_sim_status("gpu-1") == "stopped"
