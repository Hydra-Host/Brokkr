"""Apply-plan executor + resume journal. Upward references to fleet primitives use
function-body ``from local.fleet import X`` — call-time resolution avoids an import
cycle and keeps ``local.fleet`` the monkeypatch surface."""

from __future__ import annotations

import json
from pathlib import Path

from local import applied
from local.applied import AppliedManifest
from local.apply_plan import ApplyPlan, NodeAction, PlanItem
from local.config import get_settings
from local.daemons import (
    purge_ipmi_sim,
    start_ipmi_sim,
    start_socket_vmnet,
    start_sushy_emulator,
    stop_sushy_emulator,
)
from local.derived import effective_bmc_ip, effective_console_port
from local.host_os import host_os
from local.logger import log
from local.network import (
    _recover_orphaned_nics,
    ensure_data_plane_bridge,
    remove_lo_alias,
    write_bootptab,
)
from local.prefetch import prefetch_node_discovery_initrd
from local.process_utils import virsh
from local.schema import Fleet, Node


def _journal_path() -> Path:
    return get_settings().state.run_dir / "apply-journal.json"


def _journal_read(digest: str) -> set[str]:
    try:
        data = json.loads(_journal_path().read_text())
    except (FileNotFoundError, ValueError):
        return set()
    if data.get("digest") != digest:
        return set()  # journal is for a different desired topology — ignore it
    return set(data.get("completed", []))


def _journal_add(name: str, digest: str) -> None:
    completed = _journal_read(digest)
    completed.add(name)
    _journal_path().parent.mkdir(parents=True, exist_ok=True)
    applied.atomic_write_text(_journal_path(), json.dumps({"digest": digest, "completed": sorted(completed)}))


def _journal_clear() -> None:
    _journal_path().unlink(missing_ok=True)


def _redefine_and_restart(fleet: Fleet, node: Node, idx: int, fields: set[str] | None = None) -> None:
    """Cold-cycle one node so XML resource changes take effect; restart BMC daemons on a creds change.

    A bmc-creds-only change (``fields <= {"bmc"}``) restarts just ipmi_sim/sushy and skips the
    cold cycle — nothing in the rendered XML changed."""
    from local.fleet import _reclaim_stale_uuid

    hot_bmc_only = bool(fields) and fields <= {"bmc"}
    if not hot_bmc_only:
        s = get_settings()
        if virsh("domstate", node.name, check=False, capture=True).stdout.strip() == "running":
            log.info(f"power off {node.name} to apply change")
            virsh("destroy", node.name, check=False, capture=True)
        _reclaim_stale_uuid(node)
        virsh("define", str(s.state.render_dir / "domains" / f"{node.name}.xml"), capture=True)
    if fields and "bmc" in fields:
        bmc = effective_bmc_ip(node, fleet.network.bmc_cidr, idx)
        start_ipmi_sim(node, bmc, effective_console_port(node, idx))
        start_sushy_emulator(node, bmc)
    if not hot_bmc_only:
        virsh("start", node.name, capture=True)


def _recreate_overlays(node: Node, fields: list[str]) -> None:
    from local.fleet import ensure_overlay

    overlay_root = get_settings().state.overlay_root
    if "disk_gb" in fields:
        log.warn(f"recreating {node.name} OS disk — DATA ON {node.name} WILL BE LOST")
        (overlay_root / f"{node.name}.img").unlink(missing_ok=True)
    if "disks" in fields:
        for f in overlay_root.glob(f"{node.name}-d*.img"):
            f.unlink()
    ensure_overlay(node)


def _teardown_one_node(name: str, bmc_ip: str | None, purge_disks: bool = True) -> None:
    """Per-node teardown — the single-node slice of cmd_nuke. ``purge_disks=False`` preserves
    on-disk state (overlays/NVRAM/sushy conf) so a later ``node up`` finds the OS disk intact —
    ``undefine`` must pass ``--keep-nvram`` there, or libvirt deletes the NVRAM file before the
    unlink loop is ever skipped."""
    if virsh("domstate", name, check=False, capture=True).stdout.strip() == "running":
        virsh("destroy", name, check=False, capture=True)
    nvram_args = ("--nvram",) if purge_disks else ("--keep-nvram",)
    virsh("undefine", name, *nvram_args, check=False, capture=True)
    stop_sushy_emulator(name)
    purge_ipmi_sim(name)
    if bmc_ip:
        remove_lo_alias(bmc_ip)
    if host_os() == "macos":
        from local.daemons import _stop_one_socket_vmnet

        _stop_one_socket_vmnet(name)
    if not purge_disks:
        return
    s = get_settings()
    for f in [
        s.state.overlay_root / f"{name}.img",
        *s.state.overlay_root.glob(f"{name}-d*.img"),
        s.state.nvram_root / f"{name}.fd",
        s.state.sushy_conf_dir / f"{name}.conf.py",
    ]:
        Path(f).unlink(missing_ok=True)


def _refresh_data_network_if_needed(fleet: Fleet, plan: ApplyPlan) -> None:
    from local.fleet import grant_bpf

    touches = any(i.action in (NodeAction.ADD_NODE, NodeAction.REMOVE_TERMINAL_NODE) for i in plan.items)
    if not touches:
        return
    if host_os() == "macos":
        write_bootptab(fleet)
        # Re-grant on an apply that (re)starts socket_vmnet, mirroring VmOps.up (revoked on down).
        if fleet.network.dhcp:
            grant_bpf()
        restarted_nics = start_socket_vmnet(fleet)
        # apply must restart what recovery powered off — except nodes leaving the fleet and
        # nodes whose plan item cold-cycles them (starting here would use overlays not yet rebuilt).
        cold_cycled = {
            i.name
            for i in plan.items
            if i.action is NodeAction.NODE_DISK or (i.action is NodeAction.HOT_NODE and set(i.fields) - {"bmc"})
        }
        for name in _recover_orphaned_nics(restarted_nics):
            idx = next((i for i, n in enumerate(fleet.nodes) if n.name == name), None)
            if idx is not None and name not in cold_cycled:
                _redefine_and_restart(fleet, fleet.nodes[idx], idx)
    else:
        ensure_data_plane_bridge(fleet)


def _execute_item(fleet: Fleet, item: PlanItem) -> None:
    from local.fleet import _build_node_ipxe, _node_device_ids, _setup_one_node

    name = item.name
    # a removed node is gone from the desired fleet (no index there) — handle before the lookup.
    if item.action is NodeAction.REMOVE_TERMINAL_NODE:
        prev: AppliedManifest | None = applied.read()
        bmc = next((n.bmc_ip for n in prev.nodes if n.name == name), None) if prev else None
        _teardown_one_node(name, bmc)
        return
    idx = next(i for i, n in enumerate(fleet.nodes) if n.name == name)
    node = fleet.nodes[idx]
    match item.action:
        case NodeAction.NODE_DISK:
            _recreate_overlays(node, item.fields)
            _redefine_and_restart(fleet, node, idx, fields=set(item.fields))
        case NodeAction.ADD_NODE:
            device_id = _node_device_ids(fleet).get(name)
            if device_id is None:
                raise SystemExit(
                    f"add-node {name!r}: no seeded Hub Device row (BMC-IP join found nothing) — "
                    "check the sim seed or run `fleet init`"
                )
            prefetch_node_discovery_initrd(node, device_id, fleet.zone_port_ordinal(node.zone))
            _build_node_ipxe(fleet, node)
            _setup_one_node(fleet, node, idx)
        case NodeAction.HOT_NODE:
            _redefine_and_restart(fleet, node, idx, fields=set(item.fields))
        case _:
            log.skip(f"{name}: no-op action {item.action.value}")
