from __future__ import annotations

import hashlib
import json

from local import applied
from local.schema import Fleet

NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
DEFAULTS = {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"}
BM_NODE = {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}
BM_NODE_2 = {"name": "bm-2", "pxe_mac": "00:00:5e:00:53:a2", "bmc_ip": "10.0.0.21", "bmc_mac": "00:00:5e:00:53:c2"}
VM_NODE = {"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}
VALID_VM = {"network": NETWORK, "defaults": DEFAULTS, "nodes": [dict(VM_NODE)]}


def _bm(nodes=None, iface="eno1", iface_ip="10.0.0.5", network=NETWORK, vm_nodes=None) -> Fleet:
    return Fleet.model_validate(
        {
            "network": network,
            "defaults": DEFAULTS,
            "nodes": vm_nodes or [],
            "baremetal": {"iface": iface, "iface_ip": iface_ip, "arch": "amd64", "nodes": nodes or [dict(BM_NODE)]},
        }
    )


def _both(bm_nodes=None, vm_nodes=None) -> Fleet:
    return _bm(nodes=bm_nodes, vm_nodes=vm_nodes or [dict(VM_NODE)])


def _vm() -> Fleet:
    return Fleet.model_validate(VALID_VM)


def test_manifest_has_no_mode_field():
    assert "mode" not in applied.AppliedManifest.model_fields


def test_bm_manifest_records_the_bm_nodes():
    m = applied.manifest(_bm())
    assert m.nodes == []
    assert [n.name for n in m.bm_nodes] == ["bm-1"]
    assert m.bm_nodes[0].pxe_mac == "00:00:5e:00:53:a1"
    assert m.bm_nodes[0].bmc_ip == "10.0.0.20"


def test_bm_manifest_wire_carries_bmnodes_and_no_mode_key():
    wire = applied.manifest(_bm()).model_dump_wire()
    assert "mode" not in wire
    assert wire["bmNodes"][0]["name"] == "bm-1"
    assert wire["nodes"] == []


def test_two_plane_manifest_wire_carries_both_rosters():
    wire = applied.manifest(_both()).model_dump_wire()
    assert [n["name"] for n in wire["nodes"]] == ["cpu-1"]
    assert [n["name"] for n in wire["bmNodes"]] == ["bm-1"]


def test_vm_manifest_wire_omits_mode_and_bmnodes_keys():
    wire = applied.manifest(_vm()).model_dump_wire()
    assert "mode" not in wire
    assert "bmNodes" not in wire


def test_vm_digest_unchanged_by_bm_support():
    payload = {
        "network": {"cidr": _vm().network.cidr, "bmc_cidr": _vm().network.bmc_cidr, "dhcp": _vm().network.dhcp},
        "nodes": [n.fields for n in applied._resolved_nodes(_vm())],
    }
    expected = (
        "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    )
    assert applied.fleet_digest(_vm()) == expected


def test_bm_digest_changes_when_bm_roster_changes():
    one = applied.fleet_digest(_bm([dict(BM_NODE)]))
    two = applied.fleet_digest(_bm([dict(BM_NODE), dict(BM_NODE_2)]))
    assert one != two


def test_digest_changes_when_a_machine_joins_the_vm_roster():
    assert applied.fleet_digest(_vm()) != applied.fleet_digest(_both())


def test_bm_manifest_roundtrips_through_read(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    assert applied.write(_both()) is True
    m = applied.read()
    assert m is not None
    assert [n.name for n in m.nodes] == ["cpu-1"]
    assert [n.name for n in m.bm_nodes] == ["bm-1"]


def test_read_ignores_a_mode_key_in_an_old_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    wire = applied.manifest(_bm()).model_dump_wire()
    wire["mode"] = "baremetal"
    applied.applied_path().parent.mkdir(parents=True, exist_ok=True)
    applied.applied_path().write_text(json.dumps(wire))
    m = applied.read()
    assert m is not None
    assert [n.name for n in m.bm_nodes] == ["bm-1"]


def test_planes_of_reads_the_rosters():
    assert applied.planes_of([], []) == (False, False)
    assert applied.planes_of(["cpu-1"], []) == (True, False)
    assert applied.planes_of([], ["bm-1"]) == (False, True)
    assert applied.planes_of(["cpu-1"], ["bm-1"]) == (True, True)


def test_flags_a_plane_change_when_the_first_machine_is_added_and_when_the_last_vm_node_goes():
    first_machine = applied.diff(_both(), applied.manifest(_vm()), "linux")
    assert first_machine.planes_change is True
    assert first_machine.in_sync is False
    assert first_machine.severity == "hot-appliable"

    last_vm_node = applied.diff(_bm(), applied.manifest(_both()), "linux")
    assert last_vm_node.planes_change is True
    assert last_vm_node.in_sync is False
    assert last_vm_node.severity == "hot-appliable"


def test_flags_a_plane_change_when_the_last_vm_node_goes_against_a_vm_only_manifest():
    d = applied.diff(_bm(), applied.manifest(_vm()), "linux")
    assert d.planes_change is True
    assert "plane change" in (d.note or "")
    assert "fleet-planes-apply" in (d.note or "")


def test_removing_the_machine_against_a_two_plane_manifest_is_a_plane_change():
    d = applied.diff(_vm(), applied.manifest(_both()), "linux")
    assert d.planes_change is True
    assert d.severity != "needs-full-rebuild"


def test_bm_with_no_applied_manifest_is_a_plane_change():
    assert applied.diff(_bm(), None, "linux").planes_change is True
    assert applied.diff(_both(), None, "linux").planes_change is True
    assert applied.diff(_vm(), None, "linux").planes_change is False


def test_bm_in_sync_when_manifest_matches():
    m = applied.manifest(_bm())
    d = applied.diff(_bm(), m, "linux")
    assert d.in_sync is True
    assert d.planes_change is False
    assert d.severity == "in-sync"


def test_both_planes_in_sync_when_manifest_matches():
    d = applied.diff(_both(), applied.manifest(_both()), "linux")
    assert d.in_sync is True
    assert d.planes_change is False
    assert d.severity == "in-sync"
    assert d.summary.unchanged == 2


def test_both_planes_merge_drift_from_each_roster():
    m = applied.manifest(_both())
    bumped_vm = [{**VM_NODE, "memory_mb": 8192}]
    d = applied.diff(_both(bm_nodes=[dict(BM_NODE), dict(BM_NODE_2)], vm_nodes=bumped_vm), m, "linux")
    assert d.in_sync is False
    assert d.planes_change is False
    assert [n.name for n in d.nodes.added] == ["bm-2"]
    assert [c.name for c in d.nodes.changed] == ["cpu-1"]
    assert d.summary.model_dump() == {"added": 1, "removed": 0, "changed": 1, "unchanged": 1}
    assert d.severity == "needs-full-rebuild"


def test_both_planes_vm_only_drift_stays_hot_appliable():
    m = applied.manifest(_both())
    d = applied.diff(_both(vm_nodes=[{**VM_NODE, "memory_mb": 8192}]), m, "linux")
    assert d.severity == "hot-appliable"
    assert [c.name for c in d.nodes.changed] == ["cpu-1"]


def test_bm_added_node_needs_full_rebuild():
    m = applied.manifest(_bm([dict(BM_NODE)]))
    d = applied.diff(_bm([dict(BM_NODE), dict(BM_NODE_2)]), m, "linux")
    assert d.in_sync is False
    assert d.planes_change is False
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


def test_drift_summary_line_plane_change():
    d = applied.diff(_bm(), applied.manifest(_vm()), "linux")
    line = applied.drift_summary_line(d)
    assert "plane change" in line
    assert "fleet-planes-apply" in line
