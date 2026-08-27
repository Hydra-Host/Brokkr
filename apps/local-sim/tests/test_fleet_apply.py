import argparse
import json

from local import applied, apply_exec, progress
from local import fleet as fleetmod
from local.apply_plan import NodeAction, PlanItem
from local.progress import Step


def _write_fleet(tmp_path, two=True):
    nodes = "  - {name: cpu-1, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01'}\n"
    if two:
        nodes += "  - {name: cpu-2, ipmi_mac: '52:54:00:bc:00:02', data_mac: '52:54:00:da:00:02'}\n"
    p = tmp_path / "fleet.yml"
    p.write_text(
        "network: {name: brokkr-net, cidr: 192.168.200.0/24, domain: sim.local, "
        "bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 4096, disk_gb: 40, arch: x86_64}\n"
        f"nodes:\n{nodes}"
    )
    return p


def _disk_item(name: str = "cpu-1") -> PlanItem:
    return PlanItem(
        name=name, action=NodeAction.NODE_DISK, reason="disk changed", fields=["disk_gb"], eta_sec=10, data_loss=True
    )


def test_cmd_apply_plan_prints_plan_and_exits_zero(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    src = _write_fleet(tmp_path)
    rc = fleetmod.cmd_apply(argparse.Namespace(plan=True, source=str(src), allow_data_loss=False))
    plan = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert plan["fallbackFullRebuild"] is True
    assert plan["items"] == []


def test_node_disk_with_bmc_change_restarts_bmc_daemons(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    received: dict[str, object] = {}

    monkeypatch.setattr(apply_exec, "_recreate_overlays", lambda n, fields: None)
    monkeypatch.setattr(
        apply_exec, "_redefine_and_restart", lambda f, n, idx, fields=None: received.update(fields=fields)
    )

    fleet = fleetmod.load_fleet()
    item = PlanItem(
        name="cpu-1",
        action=NodeAction.NODE_DISK,
        reason="disk + bmc creds changed",
        fields=["disk_gb", "bmc"],
        eta_sec=10,
        data_loss=True,
    )
    fleetmod._execute_item(fleet, item)

    assert received["fields"] == {"disk_gb", "bmc"}


def test_journal_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    d = "sha256:abc"
    assert fleetmod._journal_read(d) == set()
    fleetmod._journal_add("cpu-1", d)
    assert "cpu-1" in fleetmod._journal_read(d)
    assert fleetmod._journal_read("sha256:other") == set()
    fleetmod._journal_clear()
    assert fleetmod._journal_read(d) == set()


def test_journal_add_writes_atomically(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))

    replaced: list[str] = []
    real_replace = applied.os.replace

    def _spy_replace(src, dst):
        replaced.append(str(dst))
        return real_replace(src, dst)

    monkeypatch.setattr(applied.os, "replace", _spy_replace)
    fleetmod._journal_add("cpu-1", "sha256:abc")

    assert str(apply_exec._journal_path()) in replaced
    assert "cpu-1" in fleetmod._journal_read("sha256:abc")


def test_cmd_apply_data_loss_gate_blocks_without_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.apply_plan import ApplyPlan

    def _fake_build_plan(diff, host_os):
        return ApplyPlan(
            fallback_full_rebuild=False,
            reason="",
            data_loss=True,
            items=[_disk_item()],
        )

    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "build_apply_plan", _fake_build_plan)

    import pytest

    with pytest.raises(SystemExit):
        fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=False))


def test_cmd_apply_data_loss_gate_passes_with_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.apply_plan import ApplyPlan

    executed: list[str] = []

    def _fake_build_plan(diff, host_os):
        return ApplyPlan(
            fallback_full_rebuild=False,
            reason="",
            data_loss=True,
            items=[_disk_item()],
        )

    def _fake_execute_item(fleet, item):
        executed.append(item.name)

    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "build_apply_plan", _fake_build_plan)
    monkeypatch.setattr(fleetmod, "render_xmls", lambda: None)
    monkeypatch.setattr(fleetmod, "_refresh_data_network_if_needed", lambda f, p: None)
    monkeypatch.setattr(fleetmod, "_execute_item", _fake_execute_item)

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=True))
    assert rc == 0
    assert "cpu-1" in executed


def test_cmd_apply_stamps_the_accelerator_on_its_first_record(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.apply_plan import ApplyPlan

    calls: list[tuple[object, dict]] = []
    monkeypatch.setattr(progress, "set", lambda step, **k: calls.append((step, k)))
    monkeypatch.setattr(fleetmod, "detect_accel", lambda: "tcg")
    monkeypatch.setattr(fleetmod, "accel_forced", lambda: False)
    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(
        fleetmod,
        "build_apply_plan",
        lambda diff, host_os: ApplyPlan(fallback_full_rebuild=False, reason="", data_loss=True, items=[_disk_item()]),
    )
    monkeypatch.setattr(fleetmod, "render_xmls", lambda: None)
    monkeypatch.setattr(fleetmod, "_refresh_data_network_if_needed", lambda f, p: None)
    monkeypatch.setattr(fleetmod, "_execute_item", lambda f, i: None)

    assert fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=True)) == 0
    assert calls[0][0] == Step.POWER_ON
    assert calls[0][1]["accel"] == "tcg"
    assert calls[0][1]["accel_forced"] is False


def test_journal_not_cleared_when_write_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.apply_plan import ApplyPlan

    def _fake_build_plan(diff, host_os):
        return ApplyPlan(
            fallback_full_rebuild=False,
            reason="",
            data_loss=True,
            items=[_disk_item()],
        )

    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "build_apply_plan", _fake_build_plan)
    monkeypatch.setattr(fleetmod, "render_xmls", lambda: None)
    monkeypatch.setattr(fleetmod, "_refresh_data_network_if_needed", lambda f, p: None)
    monkeypatch.setattr(fleetmod, "_execute_item", lambda f, i: None)
    monkeypatch.setattr(applied, "write", lambda f: False)

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=True))
    assert rc != 0

    from local import fleet as fm

    desired_fleet = fleetmod.load_fleet()
    digest = applied.fleet_digest(desired_fleet)
    assert "cpu-1" in fm._journal_read(digest)


def test_journal_cleared_when_write_succeeds(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.apply_plan import ApplyPlan

    def _fake_build_plan(diff, host_os):
        return ApplyPlan(
            fallback_full_rebuild=False,
            reason="",
            data_loss=True,
            items=[_disk_item()],
        )

    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "build_apply_plan", _fake_build_plan)
    monkeypatch.setattr(fleetmod, "render_xmls", lambda: None)
    monkeypatch.setattr(fleetmod, "_refresh_data_network_if_needed", lambda f, p: None)
    monkeypatch.setattr(fleetmod, "_execute_item", lambda f, i: None)
    monkeypatch.setattr(applied, "write", lambda f: True)

    fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=True))

    desired_fleet = fleetmod.load_fleet()
    digest = applied.fleet_digest(desired_fleet)
    assert fleetmod._journal_read(digest) == set()


def test_all_noop_apply_clears_stale_journal(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.applied import DriftNodes, DriftSummary, FleetDiff, NetworkDrift
    from local.apply_plan import ApplyPlan

    def _all_noop_plan(diff, host_os):
        return ApplyPlan(
            fallback_full_rebuild=False,
            reason="",
            data_loss=False,
            items=[PlanItem(name="cpu-1", action=NodeAction.NOOP, reason="no change", fields=[], eta_sec=0)],
        )

    def _in_sync_diff(desired, applied_manifest, host_os=None):
        return FleetDiff(
            in_sync=True,
            severity="in-sync",
            desired_digest=applied.fleet_digest(desired),
            applied_digest=applied.fleet_digest(desired),
            applied_at=1.0,
            summary=DriftSummary(),
            nodes=DriftNodes(),
            network=NetworkDrift(),
        )

    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "build_apply_plan", _all_noop_plan)
    monkeypatch.setattr(applied, "diff", _in_sync_diff)

    digest = applied.fleet_digest(fleetmod.load_fleet())
    fleetmod._journal_add("cpu-1", digest)
    assert "cpu-1" in fleetmod._journal_read(digest)

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=False))
    assert rc == 0
    assert fleetmod._journal_read(digest) == set()


def test_cmd_apply_noop_with_real_drift_does_not_clear_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    from local.applied import DriftNodes, DriftSummary, FleetDiff, NetworkDrift
    from local.apply_plan import ApplyPlan

    original_fleet = fleetmod.load_fleet()
    assert original_fleet is not None
    run_dir = tmp_path / "state" / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    applied.write(original_fleet)
    manifest_path = run_dir / "fleet-applied.json"
    assert manifest_path.exists()
    original_content = manifest_path.read_text()

    def _all_noop_plan(diff, host_os):
        return ApplyPlan(
            fallback_full_rebuild=False,
            reason="",
            data_loss=False,
            items=[
                PlanItem(name="cpu-1", action=NodeAction.NOOP, reason="nics ignored on macOS", fields=[], eta_sec=0)
            ],
        )

    def _fake_diff(desired, applied_manifest, host_os=None):
        return FleetDiff(
            in_sync=False,
            severity="hot-appliable",
            desired_digest="sha256:abc",
            applied_digest="sha256:old",
            applied_at=1.0,
            summary=DriftSummary(changed=1),
            nodes=DriftNodes(),
            network=NetworkDrift(),
        )

    monkeypatch.setattr(fleetmod, "preflight", lambda *a, **k: None)
    monkeypatch.setattr(fleetmod, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleetmod, "ensure_state_dirs", lambda: None)
    monkeypatch.setattr(fleetmod, "build_apply_plan", _all_noop_plan)
    monkeypatch.setattr(applied, "diff", _fake_diff)

    rc = fleetmod.cmd_apply(argparse.Namespace(plan=False, source=None, allow_data_loss=False))
    assert rc == 2
    assert manifest_path.read_text() == original_content


class _Running:
    stdout = "running"


def test_add_node_unseeded_node_raises_system_exit(tmp_path, monkeypatch):
    import pytest

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    monkeypatch.setattr(fleetmod, "_node_device_ids", lambda f: {})

    fleet = fleetmod.load_fleet()
    item = PlanItem(name="cpu-1", action=NodeAction.ADD_NODE, reason="append new node", fields=[], eta_sec=90)

    with pytest.raises(SystemExit, match="no seeded Hub Device row"):
        fleetmod._execute_item(fleet, item)


def test_redefine_bmc_only_restarts_daemons_without_cold_cycle(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    virsh_calls: list[tuple] = []
    daemons: list[str] = []
    reclaimed: list[str] = []

    monkeypatch.setattr(apply_exec, "virsh", lambda *a, **k: virsh_calls.append(a) or _Running())
    monkeypatch.setattr(apply_exec, "start_ipmi_sim", lambda *a, **k: daemons.append("ipmi"))
    monkeypatch.setattr(apply_exec, "start_sushy_emulator", lambda *a, **k: daemons.append("sushy"))
    monkeypatch.setattr(fleetmod, "_reclaim_stale_uuid", lambda n: reclaimed.append(n.name))

    fleet = fleetmod.load_fleet()
    apply_exec._redefine_and_restart(fleet, fleet.nodes[0], 0, fields={"bmc"})

    assert virsh_calls == []
    assert reclaimed == []
    assert daemons == ["ipmi", "sushy"]


def test_redefine_mixed_fields_still_cold_cycles(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    verbs: list[str] = []
    daemons: list[str] = []

    monkeypatch.setattr(apply_exec, "virsh", lambda *a, **k: verbs.append(a[0]) or _Running())
    monkeypatch.setattr(apply_exec, "start_ipmi_sim", lambda *a, **k: daemons.append("ipmi"))
    monkeypatch.setattr(apply_exec, "start_sushy_emulator", lambda *a, **k: daemons.append("sushy"))
    monkeypatch.setattr(fleetmod, "_reclaim_stale_uuid", lambda n: verbs.append("reclaim"))

    fleet = fleetmod.load_fleet()
    apply_exec._redefine_and_restart(fleet, fleet.nodes[0], 0, fields={"bmc", "disk_gb"})

    assert {"destroy", "define", "start", "reclaim"} <= set(verbs)
    assert daemons == ["ipmi", "sushy"]


def test_cmd_apply_source_flag_copies_to_fleet_path(tmp_path, monkeypatch):
    import pytest

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    src = _write_fleet(tmp_path)

    copied: list[tuple[str, str]] = []
    monkeypatch.setattr(fleetmod.shutil, "copyfile", lambda s, d: copied.append((str(s), str(d))))
    monkeypatch.setattr(fleetmod, "load_fleet", lambda: None)

    with pytest.raises(SystemExit):
        fleetmod.cmd_apply(argparse.Namespace(plan=False, source=str(src), allow_data_loss=False))

    assert copied and copied[0][0] == str(src)
    assert copied[0][1] == str(fleetmod.get_settings().paths.fleet_path)


def test_cmd_apply_source_conflicts_with_local_fleet_path(tmp_path, monkeypatch):
    import pytest

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    src = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(src))

    with pytest.raises(SystemExit, match="conflicts with LOCAL_FLEET_PATH"):
        fleetmod.cmd_apply(argparse.Namespace(plan=False, source=str(src), allow_data_loss=False))


def test_cmd_apply_nonexistent_source_raises(tmp_path, monkeypatch):
    import pytest

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))

    with pytest.raises(SystemExit, match="not a file"):
        fleetmod.cmd_apply(argparse.Namespace(plan=False, source=str(tmp_path / "nope.yml"), allow_data_loss=False))
    with pytest.raises(SystemExit, match="not a file"):
        fleetmod.cmd_apply(argparse.Namespace(plan=False, source=str(tmp_path), allow_data_loss=False))


def test_refresh_data_network_recovers_orphaned_nics_on_macos(tmp_path, monkeypatch):
    from local.apply_plan import ApplyPlan

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    recovered: list[list[str]] = []
    monkeypatch.setattr(apply_exec, "host_os", lambda: "macos")
    monkeypatch.setattr(apply_exec, "write_bootptab", lambda f: None)
    monkeypatch.setattr(apply_exec, "start_socket_vmnet", lambda f: ["vmenet1"])
    monkeypatch.setattr(apply_exec, "_recover_orphaned_nics", lambda nics: recovered.append(nics) or [])

    fleet = fleetmod.load_fleet()
    plan = ApplyPlan(items=[PlanItem(name="cpu-1", action=NodeAction.ADD_NODE, reason="add", fields=[], eta_sec=90)])
    fleetmod._refresh_data_network_if_needed(fleet, plan)

    assert recovered == [["vmenet1"]]


def test_refresh_data_network_restarts_downed_nodes_still_in_fleet(tmp_path, monkeypatch):
    from local.apply_plan import ApplyPlan

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    restarted: list[str] = []
    monkeypatch.setattr(apply_exec, "host_os", lambda: "macos")
    monkeypatch.setattr(apply_exec, "write_bootptab", lambda f: None)
    monkeypatch.setattr(apply_exec, "start_socket_vmnet", lambda f: ["cpu-1", "ghost-9"])
    monkeypatch.setattr(apply_exec, "_recover_orphaned_nics", lambda nics: list(nics))
    monkeypatch.setattr(apply_exec, "_redefine_and_restart", lambda f, n, i, **k: restarted.append(n.name))

    fleet = fleetmod.load_fleet()
    plan = ApplyPlan(items=[PlanItem(name="cpu-1", action=NodeAction.ADD_NODE, reason="add", fields=[], eta_sec=90)])
    fleetmod._refresh_data_network_if_needed(fleet, plan)

    assert restarted == ["cpu-1"]


def test_refresh_data_network_defers_restart_to_cold_cycling_items(tmp_path, monkeypatch):
    from local.apply_plan import ApplyPlan

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    restarted: list[str] = []
    monkeypatch.setattr(apply_exec, "host_os", lambda: "macos")
    monkeypatch.setattr(apply_exec, "write_bootptab", lambda f: None)
    monkeypatch.setattr(apply_exec, "start_socket_vmnet", lambda f: ["cpu-1", "cpu-2"])
    monkeypatch.setattr(apply_exec, "_recover_orphaned_nics", lambda nics: list(nics))
    monkeypatch.setattr(apply_exec, "_redefine_and_restart", lambda f, n, i, **k: restarted.append(n.name))

    fleet = fleetmod.load_fleet()
    plan = ApplyPlan(
        items=[
            PlanItem(name="ghost-9", action=NodeAction.REMOVE_TERMINAL_NODE, reason="rm", fields=[], eta_sec=30),
            PlanItem(name="cpu-1", action=NodeAction.NODE_DISK, reason="disk", fields=["disk_gb"], eta_sec=90),
            PlanItem(name="cpu-2", action=NodeAction.HOT_NODE, reason="bmc creds", fields=["bmc"], eta_sec=10),
        ]
    )
    fleetmod._refresh_data_network_if_needed(fleet, plan)

    assert restarted == ["cpu-2"]


def test_refresh_data_network_defers_restart_for_power_cycle_items(tmp_path, monkeypatch):
    from local.apply_plan import ApplyPlan

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    fleet_path = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))

    restarted: list[str] = []
    monkeypatch.setattr(apply_exec, "host_os", lambda: "macos")
    monkeypatch.setattr(apply_exec, "write_bootptab", lambda f: None)
    monkeypatch.setattr(apply_exec, "start_socket_vmnet", lambda f: ["cpu-1"])
    monkeypatch.setattr(apply_exec, "_recover_orphaned_nics", lambda nics: list(nics))
    monkeypatch.setattr(apply_exec, "_redefine_and_restart", lambda f, n, i, **k: restarted.append(n.name))

    fleet = fleetmod.load_fleet()
    plan = ApplyPlan(
        items=[
            PlanItem(name="ghost-9", action=NodeAction.REMOVE_TERMINAL_NODE, reason="rm", fields=[], eta_sec=30),
            PlanItem(name="cpu-1", action=NodeAction.HOT_NODE, reason="cpus changed", fields=["cpus"], eta_sec=60),
        ]
    )
    fleetmod._refresh_data_network_if_needed(fleet, plan)

    assert restarted == []


def test_full_rebuild_seeds_between_nuke_and_init(monkeypatch):
    calls: list[str] = []

    def rec(name: str, rc=None):
        def f(*_a, **_k):
            calls.append(name)
            return rc

        return f

    monkeypatch.setattr(fleetmod, "cmd_nuke", rec("nuke"))
    monkeypatch.setattr(fleetmod, "_seed_hub", rec("seed"))
    monkeypatch.setattr(fleetmod, "cmd_init", rec("init", 0))
    monkeypatch.setattr(fleetmod, "cmd_up", rec("up", 0))

    rc = fleetmod._full_rebuild(argparse.Namespace(), None)
    assert rc == 0
    assert calls == ["nuke", "seed", "init", "up"]
