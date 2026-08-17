from __future__ import annotations

from types import SimpleNamespace

import pytest
from local import reconcile_baremetal as rb


def _settings(dsn: str, redis_url: str, org: str, zone: str):
    return SimpleNamespace(
        stores=SimpleNamespace(hub_database_url=dsn, bridge_redis_url=redis_url),
        sim=SimpleNamespace(hydrahost_org_id=org),
        bridge=SimpleNamespace(zone_id=zone),
    )


_LOOPBACK_DSN = "postgresql://brokkr:brokkr@127.0.0.1:5432/brokkr"
_LOOPBACK_REDIS = "redis://127.0.0.1:6379"


def test_gate_passes_for_hermetic_local(monkeypatch):
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    s = _settings(_LOOPBACK_DSN, _LOOPBACK_REDIS, rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID)
    assert rb.assert_hermetic_local(s) == (rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID)


def test_gate_refuses_non_loopback_dsn(monkeypatch):
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    s = _settings(
        "postgresql://u:p@db.prod.internal:5432/brokkr", _LOOPBACK_REDIS, rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID
    )
    with pytest.raises(rb.ReconcileRefused, match="not loopback"):
        rb.assert_hermetic_local(s)


def test_gate_refuses_non_loopback_redis(monkeypatch):
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    s = _settings(_LOOPBACK_DSN, "redis://redis.prod.internal:6379", rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID)
    with pytest.raises(rb.ReconcileRefused, match="Redis"):
        rb.assert_hermetic_local(s)


def test_gate_refuses_without_sim_flag(monkeypatch):
    monkeypatch.delenv("LOCAL_SIMULATION_ENABLED", raising=False)
    s = _settings(_LOOPBACK_DSN, _LOOPBACK_REDIS, rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID)
    with pytest.raises(rb.ReconcileRefused, match="LOCAL_SIMULATION_ENABLED"):
        rb.assert_hermetic_local(s)


def test_gate_refuses_wrong_org_or_zone(monkeypatch):
    monkeypatch.setenv("LOCAL_SIMULATION_ENABLED", "true")
    bad_org = _settings(_LOOPBACK_DSN, _LOOPBACK_REDIS, "11111111-1111-1111-1111-111111111111", rb.HERMETIC_ZONE_ID)
    with pytest.raises(rb.ReconcileRefused, match="org"):
        rb.assert_hermetic_local(bad_org)
    bad_zone = _settings(_LOOPBACK_DSN, _LOOPBACK_REDIS, rb.HERMETIC_ORG_ID, "22222222-2222-2222-2222-222222222222")
    with pytest.raises(rb.ReconcileRefused, match="zone"):
        rb.assert_hermetic_local(bad_zone)


def test_mac_lookup_value_matches_hub_normalize():
    assert rb._mac_lookup_value("00:00:5E:00:53:B4") == "00-00-5e-00-53-b4"


def test_repair_canonical_disables_trigger_then_updates_role():
    calls: list[str] = []

    class FakeCur:
        def execute(self, sql, params=None):
            calls.append(sql)

    rb._repair_canonical_role(FakeCur(), rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID, "canon-id")
    joined = " ".join(calls)
    assert "DISABLE TRIGGER device_role_write_once" in joined
    assert "ENABLE TRIGGER device_role_write_once" in joined
    assert "role = 'Server'" in joined
    assert "ENABLE TRIGGER" in calls[-1]


def test_soft_delete_stray_sets_deletedat_not_delete():
    calls: list[str] = []

    class FakeCur:
        def execute(self, sql, params=None):
            calls.append(sql)

    rb._soft_delete_stray(FakeCur(), rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID, "stray-id")
    joined = " ".join(calls)
    assert 'UPDATE "Device" SET "deletedAt"' in joined
    assert 'UPDATE "Interface" SET "deletedAt"' in joined
    assert "DELETE FROM" not in joined


def test_reconcile_revives_soft_deleted_canonical(monkeypatch):
    from local.commission_baremetal import BareMetalNode

    node = BareMetalNode(name="bm-1", pxe_mac="00:00:5e:00:53:a1", bmc_ip="10.0.0.20", bmc_mac="00:00:5e:00:53:c1")
    canonical = rb.bm_device_uuid(node.pxe_mac)

    # Live scan misses the canonical (soft-deleted); the include_deleted scan surfaces it.
    def fake_carrying(cur, org, zone, macs, include_deleted=False):
        return [(canonical, "Server")] if include_deleted else []

    monkeypatch.setattr(rb, "_devices_carrying_mac", fake_carrying)
    repaired: list[str] = []
    monkeypatch.setattr(rb, "_repair_canonical_role", lambda cur, org, zone, dev: repaired.append(dev))

    strays, dead_ids = rb.reconcile_node(object(), rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID, node)
    assert repaired == [canonical]  # soft-deleted canonical revived via the trigger-guarded repair
    assert strays == []
    assert canonical not in dead_ids  # the canonical is never purged as a stray


def test_reconcile_no_canonical_row_does_not_repair(monkeypatch):
    from local.commission_baremetal import BareMetalNode

    node = BareMetalNode(name="bm-1", pxe_mac="00:00:5e:00:53:a1", bmc_ip="10.0.0.20", bmc_mac="00:00:5e:00:53:c1")

    # Neither scan surfaces the canonical → seed will INSERT it; no revive attempted.
    monkeypatch.setattr(rb, "_devices_carrying_mac", lambda *a, **k: [])
    repaired: list[str] = []
    monkeypatch.setattr(rb, "_repair_canonical_role", lambda cur, org, zone, dev: repaired.append(dev))

    strays, dead_ids = rb.reconcile_node(object(), rb.HERMETIC_ORG_ID, rb.HERMETIC_ZONE_ID, node)
    assert repaired == []
    assert strays == []
    assert dead_ids == []
