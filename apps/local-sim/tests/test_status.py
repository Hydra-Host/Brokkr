from __future__ import annotations

import subprocess

import pytest
import yaml
from click.testing import CliRunner
from local import host_os as host_os_mod
from local import status
from local.status import _ipmi_sim_status, _virsh_domstate, fleet_ready

_NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
_DEFAULTS = {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"}

_VM_FLEET = {
    "network": _NETWORK,
    "defaults": _DEFAULTS,
    "nodes": [{"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}],
}

_BM_FLEET = {
    "network": _NETWORK,
    "defaults": _DEFAULTS,
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


@pytest.fixture
def run_status(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path / "state"))
    monkeypatch.setattr(status, "_virsh_domstate", lambda _n: "running")
    monkeypatch.setattr(status, "_ipmi_sim_status", lambda _n: "running")
    monkeypatch.setattr(status, "_sushy_running", lambda _n: "running")
    monkeypatch.setattr(status, "_bmc_reachable", lambda *a, **k: True)
    monkeypatch.setattr(status.process_utils, "iface_ipv4", lambda _i: "10.0.0.5")
    monkeypatch.setattr("local.ipxe_build._stamped_chain_url", lambda: None)

    def _run(fleet_dict, *args):
        path = tmp_path / "fleet.yml"
        path.write_text(yaml.safe_dump(fleet_dict))
        return CliRunner().invoke(status.main, ["--fleet", str(path), *args])

    return _run


@pytest.fixture
def tcg(monkeypatch):
    monkeypatch.setattr(host_os_mod, "detect_accel", lambda: "tcg")


def test_accel_footer_is_absent_under_hardware_acceleration(monkeypatch):
    monkeypatch.setattr(host_os_mod, "detect_accel", lambda: "kvm")
    assert status._accel_footer() is None


def test_accel_footer_names_tcg(tcg):
    assert "TCG software emulation" in status._accel_footer()


def test_vm_table_emits_the_tcg_footer(run_status, tcg):
    assert "TCG software emulation" in run_status(_VM_FLEET).output


def test_baremetal_table_emits_the_tcg_footer(run_status, tcg):
    assert "TCG software emulation" in run_status(_BM_FLEET).output


def test_vm_ready_check_emits_no_footer(run_status, tcg):
    assert "TCG software emulation" not in run_status(_VM_FLEET, "--ready").output


def test_baremetal_ready_check_emits_no_footer(run_status, tcg):
    assert "TCG software emulation" not in run_status(_BM_FLEET, "--ready").output


def test_vm_table_has_no_footer_under_kvm(run_status, monkeypatch):
    monkeypatch.setattr(host_os_mod, "detect_accel", lambda: "kvm")
    assert "TCG software emulation" not in run_status(_VM_FLEET).output


def test_two_plane_fleet_prints_both_tables(run_status):
    out = run_status({**_BM_FLEET, "nodes": _VM_FLEET["nodes"]}).output
    assert "local fleet status" in out
    assert "bare-metal fleet status" in out


def test_vm_only_fleet_prints_no_bare_metal_table(run_status):
    assert "bare-metal fleet status" not in run_status(_VM_FLEET).output


def test_bare_metal_only_fleet_prints_no_vm_table(run_status):
    assert "local fleet status" not in run_status(_BM_FLEET).output


def test_two_plane_ready_check_needs_both_planes(run_status, monkeypatch):
    monkeypatch.setattr(status, "bm_ready", lambda fleet, manifest: False)
    assert run_status({**_BM_FLEET, "nodes": _VM_FLEET["nodes"]}, "--ready").exit_code == 1
    monkeypatch.setattr(status, "bm_ready", lambda fleet, manifest: True)
    assert run_status({**_BM_FLEET, "nodes": _VM_FLEET["nodes"]}, "--ready").exit_code == 0


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
