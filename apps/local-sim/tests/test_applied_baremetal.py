from __future__ import annotations

from local import applied
from local.schema import Fleet

NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
DEFAULTS = {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"}
BM_NODE = {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}
BM_NODE_2 = {"name": "bm-2", "pxe_mac": "00:00:5e:00:53:a2", "bmc_ip": "10.0.0.21", "bmc_mac": "00:00:5e:00:53:c2"}
VALID_VM = {
    "network": NETWORK,
    "defaults": DEFAULTS,
    "nodes": [{"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}],
}


def _bm(nodes=None, iface="eno1", iface_ip="10.0.0.5", network=NETWORK) -> Fleet:
    return Fleet.model_validate(
        {
            "mode": "baremetal",
            "network": network,
            "defaults": DEFAULTS,
            "nodes": [],
            "baremetal": {"iface": iface, "iface_ip": iface_ip, "arch": "amd64", "nodes": nodes or [dict(BM_NODE)]},
        }
    )


def _vm() -> Fleet:
    return Fleet.model_validate(VALID_VM)


def test_bm_manifest_records_mode_and_bm_nodes():
    m = applied.manifest(_bm())
    assert m.mode == "baremetal"
    assert [n.name for n in m.bm_nodes] == ["bm-1"]
    assert m.bm_nodes[0].pxe_mac == "00:00:5e:00:53:a1"
    assert m.bm_nodes[0].bmc_ip == "10.0.0.20"


def test_bm_manifest_wire_carries_mode_and_bmnodes():
    wire = applied.manifest(_bm()).model_dump_wire()
    assert wire["mode"] == "baremetal"
    assert wire["bmNodes"][0]["name"] == "bm-1"
    assert wire["nodes"] == []


def test_vm_manifest_wire_omits_mode_and_bmnodes_keys():
    wire = applied.manifest(_vm()).model_dump_wire()
    assert "mode" not in wire
    assert "bmNodes" not in wire


def test_vm_digest_unchanged_by_bm_support():
    d = applied.fleet_digest(_vm())
    import hashlib
    import json

    payload = {
        "network": {"cidr": _vm().network.cidr, "bmc_cidr": _vm().network.bmc_cidr, "dhcp": _vm().network.dhcp},
        "nodes": [n.fields for n in applied._resolved_nodes(_vm())],
    }
    expected = (
        "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    )
    assert d == expected


def test_bm_digest_changes_when_bm_roster_changes():
    one = applied.fleet_digest(_bm([dict(BM_NODE)]))
    two = applied.fleet_digest(_bm([dict(BM_NODE), dict(BM_NODE_2)]))
    assert one != two


def test_bm_manifest_roundtrips_through_read(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    assert applied.write(_bm()) is True
    m = applied.read()
    assert m is not None
    assert m.mode == "baremetal"
    assert [n.name for n in m.bm_nodes] == ["bm-1"]


def test_cross_mode_drift_is_mode_change_not_full_rebuild():
    applied_vm = applied.manifest(_vm())
    d = applied.diff(_bm(), applied_vm, "linux")
    assert d.mode_change is True
    assert d.in_sync is False
    assert d.severity == "hot-appliable"


def test_reverse_cross_mode_drift_is_mode_change():
    applied_bm = applied.manifest(_bm())
    d = applied.diff(_vm(), applied_bm, "linux")
    assert d.mode_change is True
    assert d.severity != "needs-full-rebuild"


def test_bm_with_no_applied_manifest_is_mode_change():
    d = applied.diff(_bm(), None, "linux")
    assert d.mode_change is True
    assert d.in_sync is False


def test_bm_in_sync_when_manifest_matches():
    m = applied.manifest(_bm())
    d = applied.diff(_bm(), m, "linux")
    assert d.in_sync is True
    assert d.mode_change is False
    assert d.severity == "in-sync"


def test_bm_added_node_needs_full_rebuild():
    m = applied.manifest(_bm([dict(BM_NODE)]))
    d = applied.diff(_bm([dict(BM_NODE), dict(BM_NODE_2)]), m, "linux")
    assert d.in_sync is False
    assert d.mode_change is False
    assert d.severity == "needs-full-rebuild"
    assert [n.name for n in d.nodes.added] == ["bm-2"]


def test_bm_removed_node_needs_full_rebuild():
    m = applied.manifest(_bm([dict(BM_NODE), dict(BM_NODE_2)]))
    d = applied.diff(_bm([dict(BM_NODE)]), m, "linux")
    assert [n.name for n in d.nodes.removed] == ["bm-2"]
    assert d.severity == "needs-full-rebuild"


def test_bm_changed_bmc_ip_needs_full_rebuild():
    m = applied.manifest(_bm([dict(BM_NODE)]))
    changed = {**BM_NODE, "bmc_ip": "10.0.0.99"}
    d = applied.diff(_bm([changed]), m, "linux")
    assert d.severity == "needs-full-rebuild"
    assert [c.name for c in d.nodes.changed] == ["bm-1"]
    assert {f.field for f in d.nodes.changed[0].fields} == {"bmc_ip"}


def test_bm_network_cidr_drift_breaks_in_sync():
    m = applied.manifest(_bm([dict(BM_NODE)]))
    drifted_net = {**NETWORK, "cidr": "10.9.0.0/24", "bmc_cidr": "10.9.1.0/24"}
    d = applied.diff(_bm([dict(BM_NODE)], network=drifted_net), m, "linux")
    assert d.in_sync is False
    assert d.network.changed is True
    assert set(d.network.fields) == {"cidr", "bmc_cidr"}
    assert d.severity == "needs-full-rebuild"


def test_bm_network_dhcp_drift_breaks_in_sync():
    m = applied.manifest(_bm([dict(BM_NODE)]))
    dhcp_net = {**NETWORK, "dhcp": True}
    d = applied.diff(_bm([dict(BM_NODE)], network=dhcp_net), m, "linux")
    assert d.in_sync is False
    assert d.network.changed is True
    assert "dhcp" in d.network.fields
    assert d.severity == "needs-full-rebuild"


def test_drift_summary_line_mode_change():
    d = applied.diff(_bm(), applied.manifest(_vm()), "linux")
    assert "mode change" in applied.drift_summary_line(d)
