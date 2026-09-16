from __future__ import annotations

from types import SimpleNamespace

import pytest
from local import reset_device as rd
from local.derived import bm_device_uuid, sim_device_uuid
from local.schema import Fleet

_PXE_MAC = "00:00:5e:00:53:b4"
_EXPECTED_UUID = "0e8c9981-6781-5e20-9d8e-a84ccf7f548a"


def _bm_fleet() -> Fleet:
    return Fleet.model_validate(
        {
            "network": {
                "name": "brokkr",
                "cidr": "192.168.200.0/24",
                "domain": "brokkr.local",
                "bmc_cidr": "192.168.105.0/24",
            },
            "nodes": [],
            "baremetal": {
                "iface": "eno1",
                "iface_ip": "198.51.100.1",
                "arch": "amd64",
                "nodes": [
                    {
                        "name": "bench-1",
                        "pxe_mac": _PXE_MAC,
                        "bmc_ip": "198.51.100.250",
                        "bmc_mac": "aa:bb:cc:dd:ee:ff",
                    }
                ],
            },
        }
    )


def _vm_fleet() -> Fleet:
    return Fleet.model_validate(
        {
            "network": {
                "name": "brokkr",
                "cidr": "192.168.200.0/24",
                "domain": "brokkr.local",
                "bmc_cidr": "192.168.105.0/24",
            },
            "nodes": [
                {"name": "gpu-1", "ipmi_mac": "52:54:00:00:00:01", "data_mac": "52:54:00:00:01:01"},
                {"name": "gpu-2", "ipmi_mac": "52:54:00:00:00:02", "data_mac": "52:54:00:00:01:02"},
            ],
        }
    )


def test_bm_resolve_node_by_name():
    fleet = _bm_fleet()
    node = rd._resolve_bm_node(fleet, "bench-1")
    assert node.pxe_mac == _PXE_MAC
    assert bm_device_uuid(node.pxe_mac) == _EXPECTED_UUID
    assert bm_device_uuid(node.pxe_mac) != sim_device_uuid(0)


def test_bm_resolve_unknown_lists_bm_names():
    fleet = _bm_fleet()
    with pytest.raises(SystemExit) as exc:
        rd._resolve_bm_node(fleet, "nope")
    assert "bench-1" in str(exc.value)


def test_bm_cycle_targets_maps_by_uuid():
    fleet = _bm_fleet()
    affected = [(_EXPECTED_UUID, "bench-1", "zone-1")]
    targets = rd._bm_cycle_targets(fleet, affected)
    assert [n.name for n in targets] == ["bench-1"]


def test_bm_cycle_targets_ignores_unmapped():
    fleet = _bm_fleet()
    affected = [("00000000-0000-0000-0000-000000000001", "gpu-1", "zone-1")]
    assert rd._bm_cycle_targets(fleet, affected) == []


def test_bm_cycle_targets_dedupes():
    fleet = _bm_fleet()
    affected = [(_EXPECTED_UUID, "bench-1", "z"), (_EXPECTED_UUID, "bench-1", "z")]
    assert [n.name for n in rd._bm_cycle_targets(fleet, affected)] == ["bench-1"]


def test_main_dispatches_to_bm_branch(monkeypatch):
    called: dict[str, object] = {}
    monkeypatch.setattr(rd, "load_fleet", lambda: _bm_fleet())
    monkeypatch.setattr(rd, "_main_baremetal", lambda fleet, arg: called.setdefault("bm", arg))
    monkeypatch.setattr(rd, "_main_vm", lambda fleet, arg: called.setdefault("vm", arg))
    rd.main(["bench-1"])
    assert called == {"bm": "bench-1"}


def test_main_dispatches_to_vm_branch(monkeypatch):
    called: dict[str, object] = {}
    monkeypatch.setattr(rd, "load_fleet", lambda: _vm_fleet())
    monkeypatch.setattr(rd, "_main_baremetal", lambda fleet, arg: called.setdefault("bm", arg))
    monkeypatch.setattr(rd, "_main_vm", lambda fleet, arg: called.setdefault("vm", arg))
    rd.main(["gpu-1"])
    assert called == {"vm": "gpu-1"}


def _two_plane_fleet() -> Fleet:
    return Fleet.model_validate(
        {
            "network": {
                "name": "brokkr",
                "cidr": "192.168.200.0/24",
                "domain": "brokkr.local",
                "bmc_cidr": "192.168.105.0/24",
            },
            "nodes": [
                {"name": "gpu-1", "ipmi_mac": "52:54:00:00:00:01", "data_mac": "52:54:00:00:01:01"},
            ],
            "baremetal": {
                "iface": "eno1",
                "iface_ip": "198.51.100.1",
                "arch": "amd64",
                "nodes": [
                    {
                        "name": "bench-1",
                        "pxe_mac": _PXE_MAC,
                        "bmc_ip": "198.51.100.250",
                        "bmc_mac": "aa:bb:cc:dd:ee:ff",
                    }
                ],
            },
        }
    )


def test_main_routes_a_bare_metal_name_in_a_two_plane_fleet(monkeypatch):
    called: dict[str, object] = {}
    monkeypatch.setattr(rd, "load_fleet", lambda: _two_plane_fleet())
    monkeypatch.setattr(rd, "_main_baremetal", lambda fleet, arg: called.setdefault("bm", arg))
    monkeypatch.setattr(rd, "_main_vm", lambda fleet, arg: called.setdefault("vm", arg))
    rd.main(["bench-1"])
    assert called == {"bm": "bench-1"}


def test_main_routes_a_vm_name_in_a_two_plane_fleet(monkeypatch):
    called: dict[str, object] = {}
    monkeypatch.setattr(rd, "load_fleet", lambda: _two_plane_fleet())
    monkeypatch.setattr(rd, "_main_baremetal", lambda fleet, arg: called.setdefault("bm", arg))
    monkeypatch.setattr(rd, "_main_vm", lambda fleet, arg: called.setdefault("vm", arg))
    rd.main(["gpu-1"])
    assert called == {"vm": "gpu-1"}


def test_main_requires_fleet(monkeypatch):
    monkeypatch.setattr(rd, "load_fleet", lambda: None)
    with pytest.raises(SystemExit, match=r"no fleet\.yml"):
        rd.main(["bench-1"])


class _RecordingCursor:
    def __init__(self, server_row=("srv-1",)):
        self.sqls: list[str] = []
        self._server_row = server_row
        self.rowcount = 0

    def execute(self, sql, params=None):
        self.sqls.append(sql)

    def fetchone(self):
        return self._server_row


def _has_data_nic_cleanup(sqls: list[str]) -> bool:
    return any('"mgmtOnly" = false' in s and "IpAddress" in s and '"deletedAt" = NOW()' in s for s in sqls)


def test_reset_postgres_bm_clears_data_nic_ips():
    cur = _RecordingCursor()
    counts = rd._reset_postgres(cur, _EXPECTED_UUID, [_EXPECTED_UUID], bm=True)
    assert _has_data_nic_cleanup(cur.sqls)
    assert not any("ii.name = 'eth0'" in s for s in cur.sqls)
    assert "data_nic_ips_cleared" in counts


def test_reset_postgres_vm_does_not_clear_data_nic_ips():
    cur = _RecordingCursor()
    counts = rd._reset_postgres(cur, sim_device_uuid(0), [sim_device_uuid(0)])
    assert not _has_data_nic_cleanup(cur.sqls)
    assert "data_nic_ips_cleared" not in counts


def test_reset_postgres_missing_server_row_raises():
    cur = _RecordingCursor(server_row=None)
    with pytest.raises(SystemExit, match="no Server row"):
        rd._reset_postgres(cur, _EXPECTED_UUID, [_EXPECTED_UUID], bm=True)


def test_vm_branch_uses_sim_uuid(monkeypatch):
    fleet = _vm_fleet()
    seen: dict[str, object] = {}

    monkeypatch.setattr(
        rd,
        "get_settings",
        lambda: SimpleNamespace(
            stores=SimpleNamespace(hub_database_url="postgresql://x", bridge_redis_url="redis://x")
        ),
    )

    def _fake_discover(cur, dev):
        seen["device_id"] = dev
        return [(sim_device_uuid(0), "gpu-1", "zone-1")]

    def _fake_cycle(name):
        seen["cycled"] = name
        return 0

    monkeypatch.setattr(rd, "_discover_affected_devices", _fake_discover)
    monkeypatch.setattr(rd, "_power_cycle", _fake_cycle)
    monkeypatch.setattr(rd, "_reset_postgres", lambda *a, **k: {})
    monkeypatch.setattr(rd, "_reset_redis", lambda *a, **k: {})

    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def cursor(self):
            return _Cur()

        def commit(self):
            pass

    monkeypatch.setattr(rd.psycopg, "connect", lambda dsn: _Conn())
    rd._main_vm(fleet, "gpu-1")
    assert seen["device_id"] == sim_device_uuid(0)
    assert seen["cycled"] == "gpu-1"
