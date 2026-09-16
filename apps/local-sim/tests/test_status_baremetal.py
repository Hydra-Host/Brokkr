from __future__ import annotations

from local import applied, status
from local.schema import Fleet

NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
DEFAULTS = {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"}
BM_NODE = {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}


VM_NODE = {"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}


def _bm(nodes=None, vm_nodes=None) -> Fleet:
    return Fleet.model_validate(
        {
            "network": NETWORK,
            "defaults": DEFAULTS,
            "nodes": vm_nodes or [],
            "baremetal": {"iface": "eno1", "iface_ip": "10.0.0.5", "arch": "amd64", "nodes": nodes or [dict(BM_NODE)]},
        }
    )


def test_bm_ready_true_when_manifest_matches():
    assert status.bm_ready(_bm(), applied.manifest(_bm())) is True


def test_bm_ready_true_when_a_two_plane_manifest_matches():
    both = _bm(vm_nodes=[dict(VM_NODE)])
    assert status.bm_ready(both, applied.manifest(both)) is True


def test_bm_ready_false_when_never_applied():
    assert status.bm_ready(_bm(), None) is False


def test_bm_ready_false_when_the_manifest_carries_only_the_vm_plane():
    vm = Fleet.model_validate({"network": NETWORK, "defaults": DEFAULTS, "nodes": [dict(VM_NODE)]})
    assert status.bm_ready(_bm(), applied.manifest(vm)) is False


def test_bm_ready_false_when_the_vm_plane_joined_since_the_apply():
    assert status.bm_ready(_bm(vm_nodes=[dict(VM_NODE)]), applied.manifest(_bm())) is False


def test_bm_ready_false_when_roster_drifted():
    two = [
        dict(BM_NODE),
        {"name": "bm-2", "pxe_mac": "00:00:5e:00:53:a2", "bmc_ip": "10.0.0.21", "bmc_mac": "00:00:5e:00:53:c2"},
    ]
    assert status.bm_ready(_bm(two), applied.manifest(_bm([dict(BM_NODE)]))) is False


def test_baked_url_in_sync(monkeypatch):
    monkeypatch.setattr("local.ipxe_build._stamped_chain_url", lambda: "http://10.0.0.5:8000")
    assert status._baked_url_drift("10.0.0.5") == "in-sync"


def test_baked_url_stale_on_ip_drift(monkeypatch):
    monkeypatch.setattr("local.ipxe_build._stamped_chain_url", lambda: "http://10.0.0.9:8000")
    assert status._baked_url_drift("10.0.0.5").startswith("stale")


def test_baked_url_no_bake_when_stamp_missing(monkeypatch):
    monkeypatch.setattr("local.ipxe_build._stamped_chain_url", lambda: None)
    assert status._baked_url_drift("10.0.0.5") == "no bake"


def test_bmc_reachable_false_on_refused_connection():
    assert status._bmc_reachable("10.255.255.1", port=1, timeout=0.2) is False
