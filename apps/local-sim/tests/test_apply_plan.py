from local.applied import FleetDiff
from local.apply_plan import NodeAction, build_apply_plan


def _diff(added=None, removed=None, changed=None, network=None):
    return FleetDiff.model_validate(
        {
            "inSync": False,
            "severity": "needs-full-rebuild",
            "desiredDigest": "sha256:x",
            "appliedDigest": "sha256:y",
            "appliedAt": 1.0,
            "summary": {
                "added": len(added or []),
                "removed": len(removed or []),
                "changed": len(changed or []),
                "unchanged": 0,
            },
            "nodes": {"added": added or [], "removed": removed or [], "changed": changed or []},
            "network": network or {"changed": False, "fields": []},
            "note": None,
        }
    )


def _changed(name, *fields):
    return {"name": name, "fields": [{"field": f, "from": "0", "to": "1"} for f in fields]}


def test_memory_change_is_hot_node():
    plan = build_apply_plan(_diff(changed=[_changed("cpu-1", "memory_mb")]), "linux")
    assert plan.fallback_full_rebuild is False
    assert plan.items[0].action == NodeAction.HOT_NODE


def test_disk_change_is_node_disk_with_data_loss():
    plan = build_apply_plan(_diff(changed=[_changed("cpu-1", "disk_gb")]), "linux")
    assert plan.items[0].action == NodeAction.NODE_DISK
    assert plan.items[0].data_loss is True
    assert plan.data_loss is True


def test_bmc_only_change_is_hot_node():
    plan = build_apply_plan(_diff(changed=[_changed("cpu-1", "bmc")]), "linux")
    assert plan.items[0].action == NodeAction.HOT_NODE
    assert plan.items[0].data_loss is False


def test_tail_append_is_add_node():
    plan = build_apply_plan(_diff(added=[{"name": "cpu-3", "zone": "sim-zone"}]), "linux")
    assert plan.items[0].action == NodeAction.ADD_NODE
    assert plan.fallback_full_rebuild is False


def test_terminal_removal_is_remove_terminal():
    plan = build_apply_plan(_diff(removed=[{"name": "cpu-2", "zone": "sim-zone"}]), "linux")
    assert plan.items[0].action == NodeAction.REMOVE_TERMINAL_NODE


def test_non_terminal_removal_forces_full_rebuild():
    # the downstream node shows up as changed with an index shift → collapse to full rebuild.
    plan = build_apply_plan(
        _diff(removed=[{"name": "cpu-1", "zone": "sim-zone"}], changed=[_changed("cpu-2", "index", "ip", "bmc_ip")]),
        "linux",
    )
    assert plan.fallback_full_rebuild is True
    assert plan.reason


def test_identity_change_forces_full_rebuild():
    plan = build_apply_plan(_diff(changed=[_changed("cpu-1", "ipmi_mac")]), "linux")
    assert plan.fallback_full_rebuild is True


def test_network_change_forces_full_rebuild():
    plan = build_apply_plan(_diff(network={"changed": True, "fields": ["cidr"]}), "linux")
    assert plan.fallback_full_rebuild is True
    assert len(plan.items) == 1
    net_item = plan.items[0]
    assert net_item.name == "network"
    assert net_item.action == NodeAction.FULL_REBUILD_REQUIRED
    assert "cidr" in net_item.fields
    assert "cidr" in net_item.reason


def test_network_change_dhcp_only_forces_full_rebuild():
    """A dhcp-only network change still forces a full rebuild (tracked for a lighter path later)."""
    plan = build_apply_plan(_diff(network={"changed": True, "fields": ["dhcp"]}), "linux")
    assert plan.fallback_full_rebuild is True
    assert len(plan.items) == 1
    net_item = plan.items[0]
    assert net_item.name == "network"
    assert net_item.action == NodeAction.FULL_REBUILD_REQUIRED
    assert "dhcp" in net_item.fields
    assert "dhcp" in net_item.reason


def test_macos_nics_only_is_noop():
    plan = build_apply_plan(_diff(changed=[_changed("cpu-1", "nics")]), "macos")
    assert plan.items[0].action == NodeAction.NOOP


def test_plan_wire_is_camelcase():
    plan = build_apply_plan(_diff(changed=[_changed("cpu-1", "disk_gb")]), "linux")
    wire = plan.model_dump_wire()
    assert set(wire) >= {"fallbackFullRebuild", "reason", "dataLoss", "etaSec", "items"}
    assert wire["items"][0]["action"] == "node-disk"


def test_no_manifest_forces_full_rebuild():
    # agrees with diff()'s severity="needs-full-rebuild" when applied_digest is None (M3).
    no_manifest_diff = FleetDiff.model_validate(
        {
            "inSync": False,
            "severity": "needs-full-rebuild",
            "desiredDigest": "sha256:x",
            "appliedDigest": None,
            "appliedAt": None,
            "summary": {"added": 2, "removed": 0, "changed": 0, "unchanged": 0},
            "nodes": {
                "added": [{"name": "cpu-1", "zone": "sim-zone"}, {"name": "cpu-2", "zone": "sim-zone"}],
                "removed": [],
                "changed": [],
            },
            "network": {"changed": False, "fields": []},
            "note": "no applied manifest — bring the fleet up once to enable precise drift",
        }
    )
    plan = build_apply_plan(no_manifest_diff, "linux")
    assert plan.fallback_full_rebuild is True
    assert plan.reason is not None
