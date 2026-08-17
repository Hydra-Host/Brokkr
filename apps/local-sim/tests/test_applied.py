import pytest
from local import applied
from local.schema import Fleet

VALID_FLEET = {
    "network": {
        "name": "brokkr-net",
        "cidr": "192.168.200.0/24",
        "domain": "sim.local",
        "bmc_cidr": "192.168.105.0/24",
    },
    "defaults": {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"},
    "nodes": [
        {"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        {"name": "cpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02"},
    ],
}


def _fleet(d=None):
    return Fleet.model_validate(d or VALID_FLEET)


def test_digest_is_stable_and_prefixed():
    d1 = applied.fleet_digest(_fleet())
    d2 = applied.fleet_digest(_fleet())
    assert d1 == d2
    assert d1.startswith("sha256:")


def test_digest_ignores_defaults_vs_per_node_equivalence():
    per_node = {
        **VALID_FLEET,
        "defaults": {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"},
        "nodes": [
            {**VALID_FLEET["nodes"][0], "memory_mb": 4096},
            VALID_FLEET["nodes"][1],
        ],
    }
    assert applied.fleet_digest(_fleet()) == applied.fleet_digest(_fleet(per_node))


def test_digest_changes_on_real_memory_change():
    bumped = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "memory_mb": 8192}, VALID_FLEET["nodes"][1]]}
    assert applied.fleet_digest(_fleet()) != applied.fleet_digest(_fleet(bumped))


def test_manifest_records_effective_ips_and_index():
    m = applied.manifest(_fleet())
    assert m.schema_version == applied.SCHEMA_VERSION
    assert m.digest.startswith("sha256:")
    assert [n.name for n in m.nodes] == ["cpu-1", "cpu-2"]
    assert m.nodes[0].index == 0
    assert m.nodes[0].ip == "192.168.200.10"
    assert m.nodes[1].bmc_ip == "192.168.105.11"


def test_manifest_wire_is_camelcase_with_snake_node_fields():
    wire = applied.manifest(_fleet()).model_dump_wire()
    assert wire["schemaVersion"] == applied.SCHEMA_VERSION
    assert wire["nodes"][0]["index"] == 0
    assert wire["nodes"][0]["memory_mb"] == 4096


def test_write_read_clear_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    assert applied.read() is None
    applied.write(_fleet())
    rec = applied.read()
    assert rec is not None
    assert rec.digest == applied.fleet_digest(_fleet())
    applied.clear()
    assert applied.read() is None


def test_diff_no_manifest_is_all_added():
    d = applied.diff(_fleet(), None)
    assert d.in_sync is False
    assert d.severity == "needs-full-rebuild"
    assert d.applied_at is None
    assert d.summary.added == 2
    assert d.note is not None


def test_diff_in_sync():
    f = _fleet()
    d = applied.diff(f, applied.manifest(f))
    assert d.in_sync is True
    assert d.severity == "in-sync"
    assert d.summary.model_dump() == {"added": 0, "removed": 0, "changed": 0, "unchanged": 2}


def test_diff_memory_change_is_changed_field():
    f0 = _fleet()
    bumped = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "memory_mb": 8192}, VALID_FLEET["nodes"][1]]}
    d = applied.diff(_fleet(bumped), applied.manifest(f0))
    assert (d.summary.added, d.summary.removed, d.summary.changed, d.summary.unchanged) == (0, 0, 1, 1)
    changed = d.nodes.changed[0]
    assert changed.name == "cpu-1"
    assert "memory_mb" in {x.field for x in changed.fields}


def test_diff_non_terminal_removal_shifts_downstream_ip():
    f0 = _fleet()
    only2 = {**VALID_FLEET, "nodes": [VALID_FLEET["nodes"][1]]}
    d = applied.diff(_fleet(only2), applied.manifest(f0))
    assert any(n.name == "cpu-1" for n in d.nodes.removed)
    changed = next(n for n in d.nodes.changed if n.name == "cpu-2")
    moved = {x.field for x in changed.fields}
    assert "index" in moved and "ip" in moved


def test_diff_tail_append_only_adds():
    f0 = _fleet()
    plus = {
        **VALID_FLEET,
        "nodes": [
            *VALID_FLEET["nodes"],
            {"name": "cpu-3", "ipmi_mac": "52:54:00:bc:00:03", "data_mac": "52:54:00:da:00:03"},
        ],
    }
    d = applied.diff(_fleet(plus), applied.manifest(f0))
    assert d.summary.added == 1 and d.summary.changed == 0
    assert d.nodes.added[0].name == "cpu-3"


def test_diff_network_change_flagged():
    f0 = _fleet()
    newnet = {**VALID_FLEET, "network": {**VALID_FLEET["network"], "cidr": "10.10.0.0/24"}}
    d = applied.diff(_fleet(newnet), applied.manifest(f0))
    assert d.network.changed is True
    assert "cidr" in d.network.fields


def _dhcp_fleet(enabled):
    return _fleet({**VALID_FLEET, "network": {**VALID_FLEET["network"], "dhcp": enabled}})


def test_diff_pre_dhcp_manifest_no_false_drift():
    m = applied.manifest(_fleet())
    m.network.pop("dhcp", None)
    d = applied.diff(_dhcp_fleet(False), m)
    assert d.network.changed is False
    assert "dhcp" not in d.network.fields


def test_diff_pre_dhcp_manifest_flags_real_enable():
    m = applied.manifest(_fleet())
    m.network.pop("dhcp", None)
    d = applied.diff(_dhcp_fleet(True), m)
    assert d.network.changed is True
    assert "dhcp" in d.network.fields


def test_diff_dhcp_toggle_flagged():
    d = applied.diff(_dhcp_fleet(True), applied.manifest(_dhcp_fleet(False)))
    assert d.network.changed is True
    assert "dhcp" in d.network.fields


def test_diff_nics_change_ignored_on_macos():
    f0 = _fleet()
    with_nics = {
        **VALID_FLEET,
        "nodes": [
            {**VALID_FLEET["nodes"][0], "nics": [{"mac": "52:54:00:da:00:0a", "model": "virtio", "link": "up"}]},
            VALID_FLEET["nodes"][1],
        ],
    }
    base = applied.manifest(f0)
    d_linux = applied.diff(_fleet(with_nics), base, "linux")
    assert d_linux.in_sync is False
    assert "nics" in {x.field for n in d_linux.nodes.changed for x in n.fields}
    d_macos = applied.diff(_fleet(with_nics), base, "macos")
    assert d_macos.in_sync is True
    assert d_macos.summary.changed == 0


def test_diff_wire_is_camelcase_contract_shape():
    wire = applied.diff(_fleet(), None).model_dump_wire()
    assert set(wire) >= {
        "inSync",
        "severity",
        "desiredDigest",
        "appliedDigest",
        "appliedAt",
        "summary",
        "nodes",
        "network",
        "note",
    }


def test_diff_changed_field_serializes_from_to():
    f0 = _fleet()
    bumped = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "memory_mb": 8192}, VALID_FLEET["nodes"][1]]}
    wire = applied.diff(_fleet(bumped), applied.manifest(f0)).model_dump_wire()
    assert set(wire["nodes"]["changed"][0]["fields"][0]) == {"field", "from", "to"}


def test_diff_bmc_password_redacted():
    f0 = _fleet()
    creds = {
        **VALID_FLEET,
        "nodes": [
            {**VALID_FLEET["nodes"][0], "bmc": {"username": "admin", "password": "s3cret"}},
            VALID_FLEET["nodes"][1],
        ],
    }
    d = applied.diff(_fleet(creds), applied.manifest(f0))
    assert d.in_sync is False
    bmc_field = next(x for x in d.nodes.changed[0].fields if x.field == "bmc")
    assert "***" in bmc_field.to and "s3cret" not in bmc_field.to


def test_drift_summary_line_variants():
    assert "not yet applied" in applied.drift_summary_line(applied.diff(_fleet(), None))
    f = _fleet()
    assert "in sync" in applied.drift_summary_line(applied.diff(f, applied.manifest(f)))


def test_diff_memory_change_is_hot_appliable():
    f0 = _fleet()
    bumped = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "memory_mb": 8192}, VALID_FLEET["nodes"][1]]}
    d = applied.diff(_fleet(bumped), applied.manifest(f0))
    assert d.severity == "hot-appliable"


def test_diff_bmc_only_change_is_hot_appliable():
    f0 = _fleet()
    creds = {
        **VALID_FLEET,
        "nodes": [
            {**VALID_FLEET["nodes"][0], "bmc": {"username": "admin", "password": "s3cret"}},
            VALID_FLEET["nodes"][1],
        ],
    }
    d = applied.diff(_fleet(creds), applied.manifest(f0))
    assert d.severity == "hot-appliable"


def test_diff_identity_change_is_needs_full_rebuild():
    f0 = _fleet()
    swapped = {
        **VALID_FLEET,
        "nodes": [
            {**VALID_FLEET["nodes"][0], "ipmi_mac": "52:54:00:bc:ff:01"},
            VALID_FLEET["nodes"][1],
        ],
    }
    d = applied.diff(_fleet(swapped), applied.manifest(f0))
    assert d.severity == "needs-full-rebuild"


def test_diff_disk_change_is_hot_appliable():
    f0 = _fleet()
    bigger = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "disk_gb": 80}, VALID_FLEET["nodes"][1]]}
    d = applied.diff(_fleet(bigger), applied.manifest(f0))
    assert d.severity == "hot-appliable"


def test_atomic_write_text_writes_content(tmp_path):
    target = tmp_path / "j.json"
    applied.atomic_write_text(target, "hello")
    assert target.read_text() == "hello"


def test_atomic_write_text_replaces_existing(tmp_path):
    target = tmp_path / "j.json"
    target.write_text("old")
    applied.atomic_write_text(target, "new")
    assert target.read_text() == "new"


def test_atomic_write_text_leaves_no_partial_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "j.json"
    target.write_text("original")

    def _boom(src, dst):
        raise OSError("replace failed")

    monkeypatch.setattr(applied.os, "replace", _boom)
    with pytest.raises(OSError):
        applied.atomic_write_text(target, "corrupt")

    assert target.read_text() == "original"
    leftovers = [p for p in tmp_path.iterdir() if p.name != "j.json"]
    assert leftovers == []
