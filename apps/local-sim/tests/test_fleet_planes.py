from __future__ import annotations

import pytest
from local import fleet as fleetmod
from local.fleet import BareMetalOps, FleetOps, VmOps, _ops_for
from local.schema import Fleet

BM_NODE = {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}
VM_NODE = {"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}
NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}
DEFAULTS = {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"}
BAREMETAL = {"iface": "eno1", "iface_ip": "10.0.0.5", "arch": "amd64", "nodes": [dict(BM_NODE)]}


def _fleet(vm_nodes: list[dict] | None, baremetal: dict | None) -> Fleet:
    data: dict = {"network": NETWORK, "defaults": DEFAULTS, "nodes": vm_nodes or []}
    if baremetal is not None:
        data["baremetal"] = baremetal
    return Fleet.model_validate(data)


def _both() -> Fleet:
    return _fleet([dict(VM_NODE)], BAREMETAL)


def _vm() -> Fleet:
    return _fleet([dict(VM_NODE)], None)


def _bm() -> Fleet:
    return _fleet([], BAREMETAL)


def _record(monkeypatch, verb: str, ret=None) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(VmOps, verb, lambda self, *a, **k: calls.append("vm") or ret)
    monkeypatch.setattr(BareMetalOps, verb, lambda self, *a, **k: calls.append("bm") or ret)
    return calls


def _plane_types(fleet: Fleet | None) -> list[type]:
    ops = _ops_for(fleet)
    assert isinstance(ops, FleetOps)
    return [type(p) for p in ops.planes]


def test_ops_for_composes_the_planes_the_rosters_carry():
    assert _plane_types(_both()) == [VmOps, BareMetalOps]
    assert _plane_types(_vm()) == [VmOps]
    assert _plane_types(_bm()) == [BareMetalOps]


def test_ops_for_none_carries_the_vm_plane_alone():
    assert _plane_types(None) == [VmOps]


@pytest.mark.parametrize(
    "verb,ret", [("preflight", None), ("up", None), ("nuke", None), ("init_targets", []), ("node_count", 0)]
)
def test_whole_fleet_verbs_fan_out_in_roster_order(monkeypatch, verb, ret):
    calls = _record(monkeypatch, verb, ret)
    getattr(_ops_for(_both()), verb)(_both())
    assert calls == ["vm", "bm"]


def test_down_fans_out_in_reverse_roster_order(monkeypatch):
    calls = _record(monkeypatch, "down")
    _ops_for(_both()).down(_both())
    assert calls == ["bm", "vm"]


@pytest.mark.parametrize("fleet_factory,expected", [(_vm, ["vm"]), (_bm, ["bm"])])
def test_up_reaches_only_the_plane_whose_roster_is_non_empty(monkeypatch, fleet_factory, expected):
    calls = _record(monkeypatch, "up")
    fleet = fleet_factory()
    _ops_for(fleet).up(fleet)
    assert calls == expected


def test_node_count_sums_both_rosters():
    assert _ops_for(_both()).node_count(_both()) == 2
    assert _ops_for(_vm()).node_count(_vm()) == 1


def test_init_targets_lists_vm_nodes_then_machines():
    assert _ops_for(_both()).init_targets(_both()) == [("cpu-1", "sim-zone"), ("bm-1", "sim-zone")]


def test_init_node_routes_by_the_roster_the_name_belongs_to(monkeypatch):
    routed: list[tuple[str, str]] = []
    monkeypatch.setattr(VmOps, "init_node", lambda self, fleet, name, *a: routed.append(("vm", name)))
    monkeypatch.setattr(BareMetalOps, "init_node", lambda self, fleet, name, *a: routed.append(("bm", name)))
    ops = _ops_for(_both())
    ops.init_node(_both(), "cpu-1", "sim-zone", None, 0)
    ops.init_node(_both(), "bm-1", "sim-zone", None, 0)
    assert routed == [("vm", "cpu-1"), ("bm", "bm-1")]


def test_cmd_node_refuses_a_bare_metal_name(monkeypatch):
    monkeypatch.setattr(fleetmod, "load_fleet", _both)
    with pytest.raises(SystemExit) as exc:
        fleetmod.cmd_node(__import__("argparse").Namespace(node="bm-1", verb="down", json=False))
    assert "VM nodes only" in str(exc.value)


def test_cmd_ensure_bridge_skips_without_a_vm_node(monkeypatch):
    monkeypatch.setattr(fleetmod, "host_os", lambda: "linux")
    monkeypatch.setattr(fleetmod, "load_fleet", _bm)
    monkeypatch.setattr(fleetmod, "ensure_data_plane_bridge", lambda f: pytest.fail("no VM plane, no br-brokkr"))
    assert fleetmod.cmd_ensure_bridge(__import__("argparse").Namespace()) == 0


def test_node_device_ids_joins_both_rosters_by_bmc_ip(monkeypatch):
    from local.stores import SimDevice

    devices = [
        SimDevice(id="dev-vm", name="cpu-1", zone_id="z", ipmi_ip="192.168.105.10", primary_ip=None),
        SimDevice(id="dev-bm", name="bm-1", zone_id="z", ipmi_ip="10.0.0.20", primary_ip=None),
    ]

    class _DB:
        @classmethod
        def from_env(cls):
            return cls()

        def get_sim_devices_by_bmc_ips(self, bmc_ips):
            return [d for d in devices if d.ipmi_ip in bmc_ips]

    monkeypatch.setattr(fleetmod, "HubDB", _DB)
    assert fleetmod._node_device_ids(_both()) == {"cpu-1": "dev-vm", "bm-1": "dev-bm"}
