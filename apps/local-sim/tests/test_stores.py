from __future__ import annotations

import psycopg
from local.stores import HubDB

_ROW = ("dev-uuid-1", "gpu-1", "zone-1", "192.168.105.10", "192.168.200.10")


def _capture_sql(monkeypatch, rows=(_ROW,)) -> dict[str, object]:
    captured: dict[str, object] = {}

    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params):
            captured["sql"] = sql
            captured["params"] = params

        def fetchall(self):
            return list(rows)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def cursor(self):
            return _Cur()

    monkeypatch.setattr(psycopg, "connect", lambda dsn: _Conn())
    return captured


def test_sim_device_lookup_filters_soft_deleted_interfaces(monkeypatch):
    captured = _capture_sql(monkeypatch)
    HubDB("postgresql://x").get_sim_devices_by_bmc_ips(["192.168.105.10"])
    sql = captured["sql"]
    assert 'ii."deletedAt" IS NULL' in sql
    assert 'ei."deletedAt" IS NULL' in sql


def test_sim_device_lookup_filters_soft_deleted_ip_addresses(monkeypatch):
    captured = _capture_sql(monkeypatch)
    HubDB("postgresql://x").get_sim_devices_by_bmc_ips(["192.168.105.10"])
    sql = captured["sql"]
    assert 'ipmi."deletedAt" IS NULL' in sql
    assert 'eth."deletedAt" IS NULL' in sql


def test_sim_device_lookup_keeps_soft_delete_pins_out_of_where(monkeypatch):
    captured = _capture_sql(monkeypatch)
    HubDB("postgresql://x").get_sim_devices_by_bmc_ips(["192.168.105.10"])
    where_clause = captured["sql"].split("WHERE", 1)[1]
    assert "deletedAt" not in where_clause


def test_sim_device_lookup_maps_rows_and_passes_bmc_ips(monkeypatch):
    captured = _capture_sql(monkeypatch)
    devices = HubDB("postgresql://x").get_sim_devices_by_bmc_ips(["192.168.105.10"])
    assert captured["params"] == (["192.168.105.10"],)
    assert len(devices) == 1
    assert devices[0].id == "dev-uuid-1"
    assert devices[0].ipmi_ip == "192.168.105.10"
    assert devices[0].primary_ip == "192.168.200.10"


def test_sim_device_lookup_skips_query_for_empty_input(monkeypatch):
    captured = _capture_sql(monkeypatch)
    assert HubDB("postgresql://x").get_sim_devices_by_bmc_ips([]) == []
    assert "sql" not in captured
