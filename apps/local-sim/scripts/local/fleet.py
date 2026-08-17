"""Fleet orchestration entry-point glue — apply, tear down, or nuke the sim fleet.

Run via ``python -m local.fleet <init|up|down|nuke> [opts]``; heavy lifting lives
in local.process_utils / local.prefetch / local.daemons / local.pxe.
"""

from __future__ import annotations

import argparse
import functools
import ipaddress
import os
import shutil
import sys
from pathlib import Path

import yaml

from local import applied, progress
from local.applied import FleetDiff
from local.apply_exec import (
    _execute_item,
    _journal_add,
    _journal_clear,
    _journal_read,
    _refresh_data_network_if_needed,
)
from local.apply_plan import ApplyPlan, NodeAction, build_apply_plan
from local.config import get_settings
from local.daemons import (
    ipmi_sim_registered_names,
    purge_ipmi_sim,
    start_ipmi_sim,
    start_socket_vmnet,
    start_sushy_emulator,
    stop_socket_vmnet,
    stop_sushy_emulator,
)
from local.derived import effective_bmc_ip, effective_console_port, effective_node_ip, managed_tag_for_slot, node_uuid
from local.grub_build import build_grub_binaries
from local.host_os import host_os
from local.live_initrd import build_bridge_agent_initrd, build_live_initrd
from local.logger import log
from local.network import (
    _recover_orphaned_nics,
    add_lo0_alias,
    add_lo_alias,
    bmc_lo_aliases,
    ensure_data_plane_bridge,
    remove_bootptab,
    remove_lo0_alias,
    remove_lo_alias,
    write_bootptab,
)
from local.node_ops import run_node_verb
from local.prefetch import assert_discovery_images_served, prefetch_node_discovery_initrd
from local.process_utils import (
    cmd_succeeds,
    ensure_sudo_cached,
    iface_ipv4,
    iface_is_up,
    run,
    sudo_priv,
    virsh,
)
from local.progress import Step
from local.pxe import build_ipxe_dhcp_image, build_ipxe_for_node
from local.render_all import render_fleet_to_dir
from local.schema import Fleet, Node, load_fleet
from local.stores import HubDB
from local.verify import run_verify


def resolve_index(arg: str, fleet: Fleet | None) -> int:
    if fleet is None:
        raise SystemExit("no fleet.yml found — run `task up` (or fleet:init) first")
    if arg.isdigit():
        idx = int(arg)
        if not 0 <= idx < len(fleet.nodes):
            raise SystemExit(f"node index {idx} out of range (fleet has {len(fleet.nodes)} nodes)")
        return idx
    for i, node in enumerate(fleet.nodes):
        if node.name == arg:
            return i
    raise SystemExit(f"unknown node {arg!r} (not a fleet node name or index)")


# ===== preflight =====


def preflight() -> None:
    """Verify required tools and daemons are present; exit(1) listing anything missing."""
    s = get_settings()
    is_mac = host_os() == "macos"
    pm = "brew install" if is_mac else "apt install"
    from local.host_os import host_arch

    qemu_bin = "qemu-system-aarch64" if host_arch() == "arm64" else "qemu-system-x86_64"

    issues: list[str] = []
    if not s.paths.fleet_path.is_file():
        issues.append(f"missing {s.paths.fleet_path}")
    if is_mac:
        qemu_pkg_hint = f"{pm} qemu"
    else:
        qemu_pkg_hint = f"{pm} qemu-system-arm" if qemu_bin.endswith("aarch64") else f"{pm} qemu-system-x86"
    for tool, hint in [
        ("virsh", f"{pm} libvirt" if is_mac else f"{pm} libvirt-clients"),
        ("qemu-img", f"{pm} qemu" if is_mac else f"{pm} qemu-utils"),
        (qemu_bin, qemu_pkg_hint),
    ]:
        if not shutil.which(tool):
            issues.append(f"{tool} not on PATH ({hint})")
    if is_mac and not s.paths.socket_vmnet_bin.is_file():
        issues.append(f"missing {s.paths.socket_vmnet_bin} (run: task setup)")
    if not s.paths.ipmi_sim.is_file():
        issues.append(f"missing ipmi_sim ({s.paths.ipmi_sim}) — build devenv/pkgs/openipmi.nix / run: task setup")
    if not s.paths.sushy.is_file():
        issues.append("missing sushy-emulator — run: task setup")
    if not _libvirtd_running():
        libvirt_hint = (
            "sudo brew services start libvirt"
            if is_mac
            else "sudo systemctl start libvirtd (and ensure $USER is in the 'libvirt' group)"
        )
        issues.append(f"libvirt not reachable ({libvirt_hint})")
    if not is_mac:
        _ensure_memlock(issues)
    if issues:
        for i in issues:
            log.error(i)
        sys.exit(1)


def _ensure_memlock(issues: list[str]) -> None:
    """Self-raise this process's memlock to unlimited if under libvirtd's floor."""
    import resource

    floor = 64 * 1024 * 1024  # libvirtd's LimitMEMLOCK — known-good floor
    soft, _ = resource.getrlimit(resource.RLIMIT_MEMLOCK)
    if soft == resource.RLIM_INFINITY or soft >= floor:
        return
    sudo_priv("memlock-raise", str(os.getpid()), check=False)
    soft, _ = resource.getrlimit(resource.RLIMIT_MEMLOCK)
    if soft != resource.RLIM_INFINITY and soft < floor:
        issues.append(
            f"memlock limit too low ({soft // (1024 * 1024)}MB) — qemu-img io_uring will fail. "
            "The sim-priv self-raise didn't take; install passwordless sim sudo with "
            "'devenv tasks run sudo:setup', then re-run."
        )


def _libvirtd_running() -> bool:
    return cmd_succeeds("virsh", "--connect", get_settings().paths.libvirt_uri, "list")


# ===== state dirs =====


def ensure_state_dirs() -> None:
    """Create every state directory local writes into. Idempotent."""
    s = get_settings()
    for d in (
        s.state.root,
        s.state.run_dir,
        s.state.log_dir,
        s.state.boot_artifact_root,
        s.state.iso_cache_root,
        s.state.overlay_root,
        s.state.nvram_root,
        s.state.render_dir,
        s.state.sushy_conf_dir,
        s.state.sushy_log_dir,
    ):
        d.mkdir(parents=True, exist_ok=True)


# ===== render =====


def render_xmls() -> None:
    """Render the per-node libvirt domain XMLs into ``state.render_dir/domains/`` from the on-disk fleet."""
    s = get_settings()
    log.info(f"render fleet.yml → {s.state.render_dir}")
    render_fleet_to_dir(
        s.paths.fleet_path,
        s.state.render_dir,
        s.paths.templates_dir,
        overlay_root=s.state.overlay_root,
        console_log_dir=s.state.log_dir,
    )


# ===== disks + NVRAM =====


def ensure_nvram(node: Node) -> Path:
    """Copy the EDK2 vars template to a per-VM NVRAM file the first time.

    Per-node copy keeps each VM's writable EFI variable store isolated.
    """
    s = get_settings()
    nvram = s.state.nvram_root / f"{node.name}.fd"
    if not nvram.is_file():
        log.info(f"copy EDK2 vars template → {nvram.name}")
        shutil.copyfile(s.paths.edk2_vars_template_path, nvram)
    return nvram


def ensure_overlay(node: Node) -> Path:
    """Create the per-VM OS disk image if missing; return its path.

    Sparse raw on APFS, not qcow2: raw routes guest ``blkdiscard`` through
    ``FALLOC_FL_PUNCH_HOLE`` (holes read zero), honoring the real-SSD discard→zero
    contract that qcow2 breaks at cluster boundaries.
    """
    overlay_root = get_settings().state.overlay_root
    overlay = overlay_root / f"{node.name}.img"
    if not overlay.is_file():
        log.info(f"create OS disk for {node.name} (sparse raw {node.disk_gb}G)")
        run("qemu-img", "create", "-f", "raw", str(overlay), f"{node.disk_gb}G")
    # Extra data disks (fleet builder) — same sparse-raw create, named <node>-d<i>.img.
    for i, d in enumerate(node.disks):
        extra = overlay_root / f"{node.name}-d{i}.img"
        if not extra.is_file():
            log.info(f"create extra disk {i} for {node.name} (sparse raw {d.size_gb}G {d.type})")
            run("qemu-img", "create", "-f", "raw", str(extra), f"{d.size_gb}G")
    return overlay


_bpf_warned = False


def grant_bpf() -> None:
    """macOS: chown /dev/bpf* to the sim user for raw DHCP sockets (opt-in dev mode).
    Caveat: BPF is allocated globally, so this grants L2 capture on ANY host interface; paired with revoke_bpf()."""
    global _bpf_warned
    if not _bpf_warned:
        log.warn(
            "DHCP mode: granting /dev/bpf* ownership to this user for the fleet lifetime — "
            "ALL host-interface L2 traffic becomes readable by this user session (revoked on fleet down)"
        )
    # Set the flag only after a successful grant: if sudo_priv raises (sim-priv not installed, a
    # NOPASSWD race), a later retry must re-show the warning rather than silently expand privilege.
    sudo_priv("bpf-grant")
    _bpf_warned = True


def revoke_bpf() -> None:
    """macOS: restore /dev/bpf* to root ownership (symmetric with grant_bpf)."""
    # Only announce if BPF was actually granted this run: revoke fires on every macOS `fleet down`
    # (idempotent), so an unconditional log would report BPF churn even for non-DHCP fleets.
    if _bpf_warned:
        log.info("revoke /dev/bpf* (restore root ownership)")
    sudo_priv("bpf-revoke", check=False)


def _build_node_ipxe(fleet: Fleet, node: Node) -> None:
    """DHCP mode: one generic per-arch image (idempotent — the 2nd node of an arch is a cache hit),
    shared by all nodes. Static mode: a per-VM binary with the node's baked static IP."""
    if fleet.network.dhcp:
        build_ipxe_dhcp_image(fleet, node.arch)
    else:
        build_ipxe_for_node(fleet, node)


# ===== per-node setup =====


def per_node_setup(fleet: Fleet) -> None:
    for idx, node in enumerate(fleet.nodes):
        _setup_one_node(fleet, node, idx)


def _reclaim_stale_uuid(node: Node) -> None:
    """Undefine any prior incarnation of ``node`` that still owns its domain UUID.

    The UUID derives from the stable IPMI MAC, not the node name, so a renamed node
    computes the same UUID and libvirt refuses ``define`` while the old name holds it.
    Reclaim on that stable identity; no-op when unclaimed or already correctly owned.
    """
    target_uuid = node_uuid(node.ipmi_mac)
    stale = virsh("domname", target_uuid, check=False, capture=True).stdout.strip()
    if not stale or stale == node.name:
        return
    log.info(f"reclaim uuid {target_uuid} from stale domain {stale!r} (renamed node)")
    if virsh("domstate", stale, check=False, capture=True).stdout.strip() == "running":
        virsh("destroy", stale, check=False, capture=True)
    virsh("undefine", stale, "--nvram", check=False, capture=True)
    stop_sushy_emulator(stale)
    purge_ipmi_sim(stale)


def _setup_one_node(fleet: Fleet, node: Node, idx: int) -> None:
    """Wire one fleet node into libvirt + ipmi_sim + sushy.

    Ordering constraints: ``_reclaim_stale_uuid`` before ``virsh define`` (one-UUID↔
    one-domain); ``define`` before ``start_ipmi_sim`` (chassis hook resolves the domain
    by name); the loopback alias before ``start_ipmi_sim`` (it binds ``{bmc}:623`` on it).
    """
    s = get_settings()
    ensure_overlay(node)
    ensure_nvram(node)
    bmc = effective_bmc_ip(node, fleet.network.bmc_cidr, idx)
    add_lo0_alias(bmc)

    _reclaim_stale_uuid(node)
    virsh("define", str(s.state.render_dir / "domains" / f"{node.name}.xml"), capture=True)

    log.info(f"ipmi_sim {node.name} on BMC plane {bmc}:623 (lo0 alias, not the VM's data IP)")
    data_ip = effective_node_ip(node, fleet.network.cidr, idx)
    log.info(f"  → {node.name} data plane: ssh root@{data_ip}")
    start_ipmi_sim(node, bmc, effective_console_port(node, idx))

    start_sushy_emulator(node, bmc)

    state = virsh("domstate", node.name, capture=True).stdout.strip()
    if state != "running":
        log.info(f"power on {node.name} (was {state!r})")
        virsh("start", node.name, capture=True)
    else:
        log.skip(f"{node.name} already running")


def _records_failure(prefix: str):
    """Decorator: on any exception, stamp the reason (incl. a captured ``CalledProcessError``'s
    ``.stderr``, which ``str(e)`` omits) onto fleet-progress.json, then re-raise."""

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **k):
            try:
                return fn(*a, **k)
            except Exception as e:
                stderr = getattr(e, "stderr", None)
                detail = f"{e}\n{stderr.strip()}" if isinstance(stderr, str) and stderr.strip() else str(e)
                progress.error(f"{prefix}: {detail}")
                raise

        return wrapper

    return deco


def bm_preflight(fleet: Fleet | None) -> None:
    bm = fleet.baremetal_raw if fleet is not None else None
    if bm is None:
        sys.exit("baremetal mode requires a 'baremetal' block")
    issues: list[str] = []
    if not iface_is_up(bm.iface):
        issues.append(f"uplink iface {bm.iface!r} is not up (ip link set {bm.iface} up)")
    iface_ip = iface_ipv4(bm.iface)
    if iface_ip is None:
        issues.append(f"uplink iface {bm.iface!r} carries no IPv4 address")
    if not shutil.which("docker"):
        issues.append("docker not on PATH (apt install docker.io) — needed for the iPXE bake")
    if issues:
        for i in issues:
            log.error(i)
        sys.exit(1)
    log.info(f"bare-metal preflight ok — iface {bm.iface} up, iface_ip {iface_ip}, docker present")


class ModeOps:
    def preflight(self, fleet: Fleet | None) -> None:
        raise NotImplementedError

    def init_node(self, fleet: Fleet, name: str, zone: str, device_id: str | None, ordinal: int) -> None:
        raise NotImplementedError

    def up(self, fleet: Fleet) -> None:
        raise NotImplementedError

    def down(self, fleet: Fleet) -> None:
        raise NotImplementedError

    def nuke(self, fleet: Fleet | None) -> None:
        raise NotImplementedError

    @staticmethod
    def node_count(fleet: Fleet) -> int:
        raise NotImplementedError

    @staticmethod
    def init_targets(fleet: Fleet) -> list[tuple[str, str]]:
        raise NotImplementedError


class VmOps(ModeOps):
    def preflight(self, fleet: Fleet | None) -> None:
        del fleet
        preflight()

    def init_node(self, fleet: Fleet, name: str, zone: str, device_id: str | None, ordinal: int) -> None:
        node = next(n for n in fleet.nodes if n.name == name)
        if device_id:
            log.info(f"warm brokkr-discovery-{device_id}.img for {name} on zone '{zone}' (ordinal {ordinal})")
            prefetch_node_discovery_initrd(node, device_id, ordinal)
        else:
            log.skip(f"skip discovery-initrd prefetch for {name} (no Hub Device row — builds on-demand at boot)")
        if fleet.network.dhcp:
            log.info(f"build generic dhcp iPXE image for {node.arch} (shared; requested for {name})")
        else:
            log.info(f"build per-VM iPXE binary for {name} (zone '{zone}')")
        _build_node_ipxe(fleet, node)

    def up(self, fleet: Fleet) -> None:
        progress.set(Step.RENDER, started=True)
        render_xmls()

        progress.set(Step.DAEMONS)
        restarted_nics: list[str] = []
        if host_os() == "macos":
            write_bootptab(fleet)
            # DHCP mode needs the spoke to open raw /dev/bpf sockets for its DHCP replies (revoked on down).
            if fleet.network.dhcp:
                grant_bpf()
            restarted_nics = start_socket_vmnet(fleet)
        else:
            ensure_data_plane_bridge(fleet)

        for idx in range(len(fleet.nodes)):
            add_lo_alias(effective_bmc_ip(fleet.nodes[idx], fleet.network.bmc_cidr, idx))

        _recover_orphaned_nics(restarted_nics)
        _prepare_console_logs(fleet)

        progress.set(Step.POWER_ON, total=len(fleet.nodes))
        per_node_setup(fleet)
        _make_console_logs_readable(fleet)

    def down(self, fleet: Fleet) -> None:
        _vm_down(fleet)

    def nuke(self, fleet: Fleet | None) -> None:
        _vm_nuke_extras(fleet)

    @staticmethod
    def node_count(fleet: Fleet) -> int:
        return len(fleet.nodes)

    @staticmethod
    def init_targets(fleet: Fleet) -> list[tuple[str, str]]:
        return [(n.name, n.zone) for n in fleet.nodes]


class BareMetalOps(ModeOps):
    def preflight(self, fleet: Fleet | None) -> None:
        bm_preflight(fleet)

    def init_node(self, fleet: Fleet, name: str, zone: str, device_id: str | None, ordinal: int) -> None:
        node = next(n for n in fleet.bm_nodes if n.name == name)
        if device_id:
            log.info(f"warm brokkr-discovery-{device_id}.img for {name} on zone '{zone}' (ordinal {ordinal})")
            prefetch_node_discovery_initrd(node, device_id, ordinal)
        else:
            log.skip(f"skip discovery-initrd prefetch for {name} (no Hub Device row — builds on-demand at boot)")

    def up(self, fleet: Fleet) -> None:
        log.info(
            f"bare-metal mode — no VMs to render/power; the spoke answers DHCP proxy on "
            f"{fleet.baremetal_raw.iface if fleet.baremetal_raw else '?'} for {len(fleet.bm_nodes)} seeded node(s)"
        )

    def down(self, fleet: Fleet) -> None:  # noqa: ARG002
        log.info("bare-metal fleet — nothing to power off (no VMs / BMC daemons)")

    def nuke(self, fleet: Fleet | None) -> None:
        # No live VMs/BMC daemons of our own, but still run the VM sweep: a fleet switched from VM
        # mode (or a mixed history) can leave orphan libvirt domains + sim VM state behind.
        log.info("bare-metal fleet — sweeping any VM-mode leftovers (libvirt domains / sim state)")
        _vm_nuke_extras(fleet)

    @staticmethod
    def node_count(fleet: Fleet) -> int:
        return len(fleet.bm_nodes)

    @staticmethod
    def init_targets(fleet: Fleet) -> list[tuple[str, str]]:
        return [(n.name, n.zone) for n in fleet.bm_nodes]


def _ops_for(fleet: Fleet | None) -> ModeOps:
    return BareMetalOps() if (fleet is not None and fleet.mode == "baremetal") else VmOps()


# ===== cmd_init =====


@_records_failure("fleet init failed")
def cmd_init(args: argparse.Namespace) -> int:
    """One-time-per-artifact-version preparation (slow, idempotent; split from cmd_up).

    Ordering constraints: the sim seed precedes ``_node_device_ids`` +
    ``prefetch_node_discovery_initrd`` (the BMC-IP join needs the seeded Device rows);
    discovery-initrd prefetch precedes ``build_ipxe_for_node`` so the artifact is warm.
    """
    del args
    fleet = load_fleet()
    ops = _ops_for(fleet)
    ops.preflight(fleet)
    ensure_sudo_cached()
    ensure_state_dirs()
    assert_discovery_images_served(fleet)

    progress.set(Step.BUILD_LIVE_IMG, started=True)
    log.info("build brokkr-live.img")
    live, rebuilt = build_live_initrd()
    log.info(f"  → {'built' if rebuilt else 'up-to-date'} {live} ({live.stat().st_size} bytes)")

    progress.set(Step.BUILD_AGENT_IMG)
    log.info("build bridge-agent.img")
    agent_img, agent_rebuilt = build_bridge_agent_initrd()
    log.info(f"  → {'built' if agent_rebuilt else 'up-to-date'} {agent_img} ({agent_img.stat().st_size} bytes)")

    progress.set(Step.BUILD_GRUB)
    log.info("build grub boot-from-disk binaries (served at /api/chain → /api/grub)")
    build_grub_binaries()

    node_device_ids = _node_device_ids(fleet)
    log.info(f"node → Device.id map: {node_device_ids}")

    targets = ops.init_targets(fleet)
    total = len(targets)
    for i, (name, zone) in enumerate(targets):
        device_id = node_device_ids.get(name)
        ordinal = fleet.zone_port_ordinal(zone)
        progress.set(Step.PREFETCH, label=f"warming discovery image for {name}", node=name, index=i + 1, total=total)
        progress.set(Step.BUILD_IPXE, label=f"per-node init for {name}", node=name, index=i + 1, total=total)
        ops.init_node(fleet, name, zone, device_id, ordinal)

    log.info("fleet init complete")
    return 0


def _node_device_ids(fleet: Fleet) -> dict[str, str]:
    """Map each fleet node's name → ``Hub.Device.id`` UUID, joining by BMC IP.

    Nodes with no matching Hub row are tolerated (omitted from the map) — a decommissioned
    node has no seeded id until re-commissioned; each caller decides how to handle a missing id.
    """
    if fleet.mode == "baremetal":
        name_by_bmc = {n.bmc_ip: n.name for n in fleet.bm_nodes}
        all_names = [n.name for n in fleet.bm_nodes]
    else:
        name_by_bmc = {effective_bmc_ip(n, fleet.network.bmc_cidr, i): n.name for i, n in enumerate(fleet.nodes)}
        all_names = [n.name for n in fleet.nodes]
    devices = HubDB.from_env().get_sim_devices_by_bmc_ips(list(name_by_bmc))
    out: dict[str, str] = {}
    for d in devices:
        name = name_by_bmc.get(d.ipmi_ip)
        if name and d.id:
            out[name] = d.id
    unseeded = [name for name in all_names if name not in out]
    if unseeded:
        log.warn(f"no seeded Hub Device row for {unseeded} (BMC-IP join found nothing)")
    return out


# ===== cmd_up =====


@_records_failure("fleet up failed")
def cmd_up(args: argparse.Namespace) -> int:
    """Bring the fleet online (fast path — assumes ``cmd_init`` already ran).

    Ordering constraints: libvirt up before ``per_node_setup`` (enforced by the
    process-compose DAG, not here); BMC loopback aliases exist before it starts each
    node's ipmi_sim, which binds ``{bmc}:623`` on the alias.

    With ``--supervise`` (the devenv ``fleet`` process), block foreground after bring-up
    and run ``cmd_down`` on SIGTERM/SIGINT; otherwise return once VMs are powered on.
    """
    supervise = getattr(args, "supervise", False)
    fleet = load_fleet()
    ops = _ops_for(fleet)
    ops.preflight(fleet)
    ensure_sudo_cached()
    ensure_state_dirs()

    ops.up(fleet)
    log.info("fleet up")
    progress.set(Step.READY, total=ops.node_count(fleet))
    applied.write(fleet)
    if supervise:
        return _supervise()
    return 0


def _supervise() -> int:
    """Block until SIGTERM/SIGINT, then tear the fleet down and exit 0.

    The handler only sets an event — teardown runs once after the wait returns, so a
    repeated signal mid-teardown can't re-enter it.
    """
    import signal
    import threading

    stop = threading.Event()

    def _on_signal(signum: int, _frame: object) -> None:
        log.info(f"fleet supervisor caught {signal.Signals(signum).name} — tearing down")
        progress.set(Step.TEARING_DOWN)
        stop.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    log.info("fleet supervised — waiting for a shutdown signal (SIGTERM/SIGINT)")
    stop.wait()
    return cmd_down(argparse.Namespace())


def _prepare_console_logs(fleet: Fleet) -> None:
    """Make each VM's serial log readable without sudo before per_node_setup cold-boots.

    qemu reopens (never recreates) the inode with ``append='on'``, so pre-creating it
    0644 as the calling user keeps it readable across reboots. Existing logs are
    truncated in place (not unlinked — a running qemu keeps appending). Best-effort.
    """
    log_dir = get_settings().state.log_dir
    for node in fleet.nodes:
        path = log_dir / f"{node.name}.log"
        if path.exists():
            sudo_priv("console-prepare", str(path), check=False)
        else:
            try:
                path.touch(mode=0o644)
                path.chmod(0o644)
            except OSError:
                pass


def _make_console_logs_readable(fleet: Fleet) -> None:
    """Re-grant read on each serial log after domains start (Linux fix, best-effort).

    ``qemu:///system`` relabels ``<log>`` to ``root:0600`` at start, overriding the
    0644 pre-create; a post-start ``sudo chmod a+r`` fixes it. No-op on macOS.
    """
    log_dir = get_settings().state.log_dir
    for node in fleet.nodes:
        path = log_dir / f"{node.name}.log"
        if path.exists():
            sudo_priv("console-readable", str(path), check=False)


# ===== cmd_down =====


# Namespace tagging every sim domain (templates/domain.xml.j2) so teardown finds all
# app-managed VMs by tag — including orphans removed from the config. The tag VALUE is
# per-slot (managed_tag_for_slot) so one stack's sweep never matches a sibling's domains.
BROKKR_DOMAIN_NS = "https://brokkr.local/sim/v1"


def brokkr_tagged_domains(tag: str | None = None) -> list[str]:
    """Names of all defined libvirt domains carrying this slot's managed tag.

    ``virsh metadata --uri`` exits 0 with empty output when absent, so presence is
    decided by the marker in stdout — never by exit code (else every domain matches).
    The ``>{tag}<`` framing keeps slot 0's legacy ``brokkr-local`` from substring-matching
    a sibling's ``brokkr-local-s<N>``.
    """
    if tag is None:
        tag = managed_tag_for_slot(get_settings().sim.slot)
    out = []
    for name in virsh("list", "--all", "--name", capture=True, check=False).stdout.split():
        if not name.strip():
            continue
        res = virsh("metadata", name, "--uri", BROKKR_DOMAIN_NS, capture=True, check=False)
        if f">{tag}<" in res.stdout:
            out.append(name)
    return out


def cmd_down(args: argparse.Namespace) -> int:
    """Power the fleet down (domains stay DEFINED; overlays + NVRAM kept)."""
    del args
    fleet = load_fleet()
    _ops_for(fleet).down(fleet)
    progress.set(Step.IDLE)
    return 0


def _vm_down(fleet: Fleet | None) -> None:
    s = get_settings()
    if fleet is not None:
        # Power the VMs off FIRST (virsh needs no sudo, so a later ipmi_sim/lo-alias sudo stall can't
        # leave domains running). check=False so a destroy race can't abort teardown; domains stay DEFINED.
        for node in fleet.nodes:
            if cmd_succeeds("virsh", "--connect", s.paths.libvirt_uri, "dominfo", node.name):
                if virsh("domstate", node.name, capture=True, check=False).stdout.strip() == "running":
                    log.info(f"power off domain {node.name}")
                    virsh("destroy", node.name, check=False, capture=True)
        for idx, node in enumerate(fleet.nodes):
            stop_sushy_emulator(node.name)
            purge_ipmi_sim(node.name)
            remove_lo0_alias(effective_bmc_ip(node, fleet.network.bmc_cidr, idx))
    if host_os() == "macos":
        remove_bootptab()
        # Revoke unconditionally (not gated on network.dhcp): dhcp may have been flipped off before
        # teardown, so always restore /dev/bpf* ownership. revoke_bpf() is check=False / idempotent.
        revoke_bpf()
        stop_socket_vmnet()
    # Linux: intentionally leave the br-brokkr L2 bridge up; fleet:up re-creates it idempotently
    # anyway, and other checkouts may share it. fleet:nuke deletes it explicitly.
    log.info("fleet down (powered off; domains + overlays preserved)")


# ===== cmd_nuke =====


def cmd_nuke(args: argparse.Namespace) -> int:
    """``cmd_down`` plus delete all per-VM state — overlays, NVRAM, sushy configs, wipe memos.

    Unlike ``cmd_down`` (current nodes only), this also sweeps every orphan — tagged
    domains, ipmi_sim config dirs, sushy procs, BMC-plane lo aliases.
    """
    cmd_down(args)
    fleet = load_fleet()
    _ops_for(fleet).nuke(fleet)
    log.info("nuke complete")
    progress.clear()
    applied.clear()
    return 0


def _vm_nuke_extras(fleet: Fleet | None) -> None:
    s = get_settings()

    # Orphaned managed domains (removed from the fleet, still defined) — scoped to this
    # slot's tag so a sibling stack's domains are never swept.
    for dom in brokkr_tagged_domains():
        log.info(f"nuke orphaned domain {dom} (removed from fleet, still defined)")
        if virsh("domstate", dom, capture=True, check=False).stdout.strip() == "running":
            virsh("destroy", dom, check=False, capture=True)
        virsh("undefine", dom, "--nvram", check=False, capture=True)

    for pidf in s.state.run_dir.glob("sushy.*.pid"):
        stop_sushy_emulator(pidf.name[len("sushy.") : -len(".pid")])
    for name in ipmi_sim_registered_names():
        log.info(f"purge orphan ipmi_sim {name}")
        purge_ipmi_sim(name)
    if fleet is not None:
        for ip in bmc_lo_aliases(fleet.network.bmc_cidr):
            remove_lo_alias(ip)

    log.info("remove overlays")
    for f in s.state.overlay_root.glob("*.img"):
        f.unlink()
    log.info("remove per-VM EFI NVRAM stores")
    for f in s.state.nvram_root.glob("*.fd"):
        f.unlink()
    log.info("remove per-node sushy configs")
    for f in s.state.sushy_conf_dir.glob("*.conf.py"):
        f.unlink()
    if host_os() != "macos":
        log.info(f"delete L2 data-plane bridge {s.paths.data_bridge}")
        # pass the CIDR (when a fleet is loaded) so the NAT MASQUERADE rule is removed too.
        nat_cidr = [str(ipaddress.ip_network(fleet.network.cidr, strict=False))] if fleet is not None else []
        sudo_priv("bridge-del", s.paths.data_bridge, *nat_cidr, check=False)


def _seed_hub() -> None:
    """Run the generator-driven SQL hub seed (idempotent). Required after a nuke / before an
    add-node so Hub Device rows match the desired fleet (`_node_device_ids` joins by BMC IP)."""
    seed_script = Path(__file__).resolve().parents[2] / "scripts" / "tasks" / "sql-seed-run.sh"
    run("bash", str(seed_script))


def _full_rebuild(args: argparse.Namespace, desired: Fleet) -> int:
    del desired
    cmd_nuke(args)
    _seed_hub()  # nuke→seed→init→up — cmd_init's _node_device_ids needs up-to-date Device rows
    rc = cmd_init(args)
    if rc != 0:
        return rc
    return cmd_up(args)


def _compute_plan(desired: Fleet, diff: FleetDiff | None = None) -> tuple[ApplyPlan, FleetDiff]:
    """Classify desired-vs-applied drift into a per-node apply plan, returning plan + diff.

    host_os threads into both the diff (excluding platform-unappliable fields) and the classifier.
    """
    if diff is None:
        diff = applied.diff(desired, applied.read(), host_os())
    return build_apply_plan(diff, host_os()), diff


def _commit_applied(desired: Fleet) -> bool:
    """Persist the applied manifest and clear the apply journal on success; on write failure
    return False and keep the journal for a safe resume, so callers exit non-zero."""
    if not applied.write(desired):
        log.error("failed to persist applied manifest — keeping the apply journal for a safe resume")
        return False
    _journal_clear()
    return True


@_records_failure("fleet apply failed")
def cmd_apply(args: argparse.Namespace) -> int:
    """Apply pending config with minimal per-node ops; full rebuild only on identity shifts.

    ``--plan`` prints the JSON plan and changes nothing; ``--allow-data-loss`` permits
    per-node disk recreate. Source precedence: an explicit ``--source`` wins (conflicts
    with a pinned ``LOCAL_FLEET_PATH`` or a non-file path); else the staged ``fleet.yml``
    is seeded from ``$LOCAL_FLEET_SOURCE`` only when ``LOCAL_FLEET_PATH`` is unpinned.
    """
    source = getattr(args, "source", None)
    if getattr(args, "plan", False):
        path = _desired_fleet_path(source)
        desired = Fleet.model_validate(yaml.safe_load(path.read_text()))
        plan, _ = _compute_plan(desired)
        print(plan.model_dump_json(by_alias=True))
        return 0

    if source is not None:
        if os.environ.get("LOCAL_FLEET_PATH"):
            raise SystemExit("--source conflicts with LOCAL_FLEET_PATH (both pin the desired topology) — unset one")
        if not Path(source).is_file():
            raise SystemExit(f"--source is not a file: {source}")
        shutil.copyfile(source, get_settings().paths.fleet_path)
    elif not os.environ.get("LOCAL_FLEET_PATH"):
        src = os.environ.get("LOCAL_FLEET_SOURCE")
        if src and Path(src).exists():
            shutil.copyfile(src, get_settings().paths.fleet_path)
    desired = load_fleet()
    if desired is None:
        raise SystemExit("no fleet.yml found — run `task up` first")

    _ops_for(desired).preflight(desired)
    ensure_sudo_cached()
    ensure_state_dirs()

    live_diff = applied.diff(desired, applied.read(), host_os())
    if live_diff.mode_change:
        log.warn(
            f"mode change pending ({live_diff.note}) — route through the lab's fleet-mode-apply op, not `fleet apply`"
        )
        return 3
    if desired.mode != "vm":
        if live_diff.in_sync:
            log.info("bare-metal fleet already in sync")
            return 0 if _commit_applied(desired) else 1
        log.warn("bare-metal drift pending — the lab converges it (Fleet apply); `fleet apply` does not")
        return 3

    plan, live_diff = _compute_plan(desired, live_diff)
    if plan.fallback_full_rebuild:
        log.warn(f"incremental apply not possible: {plan.reason} — full rebuild")
        return _full_rebuild(args, desired)
    if plan.data_loss and not getattr(args, "allow_data_loss", False):
        raise SystemExit("plan wipes a node disk; re-run with --allow-data-loss or use Fleet rebuild")

    actionable = [i for i in plan.items if i.action != NodeAction.NOOP]
    if not actionable:
        # all-noop plan: verify genuinely in sync before committing — _classify_changed can return
        # NOOP for fields outside the identity/hot/disk sets while the diff still reports drift.
        if not live_diff.in_sync:
            log.warn(
                f"plan is all-noop but fleet is not in sync (severity={live_diff.severity}) — skipping manifest write"
            )
            return 2
        log.info("fleet already in sync")
        # in sync ⇒ no apply in progress ⇒ a leftover journal is stale
        return 0 if _commit_applied(desired) else 1

    if any(i.action == NodeAction.ADD_NODE for i in actionable):
        log.info("seeding hub for add-node")
        _seed_hub()

    render_xmls()
    _refresh_data_network_if_needed(desired, plan)
    desired_digest = applied.fleet_digest(desired)
    done = _journal_read(desired_digest)
    progress.set(Step.POWER_ON, total=len(actionable))
    for i, item in enumerate(actionable, 1):
        if item.name in done:  # journaled = fully applied; never re-run (a re-run must not re-wipe a node-disk)
            log.skip(f"{item.name} already applied this run")
            continue
        progress.set(Step.POWER_ON, label=item.reason, node=item.name, index=i, total=len(actionable))
        _execute_item(desired, item)
        _journal_add(item.name, desired_digest)

    # the changes hit libvirt; if the manifest doesn't persist, fail (keeping the journal for a
    # resume) so callers don't read exit 0 as a clean apply and clear their drift state.
    if not _commit_applied(desired):
        return 1
    progress.set(Step.READY, total=len(desired.nodes))
    log.info("fleet apply complete")
    return 0


def _desired_fleet_path(source: str | None = None) -> Path:
    """The topology the CLI diffs/applies against — an explicit --source, else the staged fleet.yml."""
    return Path(source) if source else get_settings().paths.fleet_path


def cmd_diff(args: argparse.Namespace) -> int:
    """Print the desired-vs-applied drift as JSON; exit 2 on drift, 0 in-sync."""
    source = getattr(args, "source", None)
    path = _desired_fleet_path(source)
    desired = Fleet.model_validate(yaml.safe_load(path.read_text()))
    result = applied.diff(desired, applied.read(), host_os())
    print(result.model_dump_json(by_alias=True))
    return 0 if result.in_sync else 2


def cmd_ensure_bridge(args: argparse.Namespace) -> int:  # noqa: ARG001
    """Create the flat L2 data-plane bridge ``br-brokkr`` (Linux only)"""
    if host_os() == "macos":
        log.skip("macOS uses socket_vmnet — no L2 data-plane bridge")
        return 0
    fleet = load_fleet()
    if fleet is None:
        raise SystemExit("no fleet.yml found — run `task up` (or fleet:init) first")
    if fleet.mode == "baremetal":
        log.skip("bare-metal mode — real host NIC, br-brokkr not needed")
        return 0
    ensure_data_plane_bridge(fleet)
    return 0


def cmd_node(args: argparse.Namespace) -> int:
    """Run one per-node lifecycle verb (vm-mode fleets only)."""
    fleet = load_fleet()
    if fleet is None:
        raise SystemExit("no fleet.yml found — run `task up` (or fleet:init) first")
    if fleet.mode == "baremetal":
        raise SystemExit("node verbs are vm-mode only — bare-metal power routes via the lab's redfish op")
    idx = resolve_index(args.node, fleet)
    return run_node_verb(fleet, idx, args.verb, as_json=args.json, purge=getattr(args, "purge", False))


def cmd_verify(args: argparse.Namespace) -> int:
    """Verify the applied fleet's live daemons/domains; ``--heal`` repairs healable findings."""
    fleet = load_fleet()
    manifest = applied.read()
    return run_verify(fleet, manifest, heal=args.heal, as_json=args.json)


# ===== CLI =====


def main() -> int:
    p = argparse.ArgumentParser(prog="python -m local.fleet")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser(
        "init",
        help="warm bridge cache + build brokkr-live.img + build per-VM iPXE binaries. Slow, idempotent.",
    )
    p_init.set_defaults(func=cmd_init)

    p_up = sub.add_parser(
        "up",
        help="render XMLs + start daemons + start ipmi_sim/sushy per node. Assumes `init` has run.",
    )
    p_up.add_argument(
        "--supervise",
        action="store_true",
        help="after bring-up, stay foreground and run `down` on SIGTERM/SIGINT (the devenv fleet process uses this).",
    )
    p_up.set_defaults(func=cmd_up)

    p_down = sub.add_parser("down", help="stop BMCs and undefine domains (overlays preserved)")
    p_down.set_defaults(func=cmd_down)

    p_nuke = sub.add_parser("nuke", help="fleet down + delete overlays")
    p_nuke.set_defaults(func=cmd_nuke)

    p_bridge = sub.add_parser(
        "ensure-bridge",
        help="create the flat L2 data-plane bridge br-brokkr (Linux; macOS no-op). Idempotent.",
    )
    p_bridge.set_defaults(func=cmd_ensure_bridge)

    p_diff = sub.add_parser("diff", help="print desired-vs-applied drift JSON (exit 2 on drift)")
    p_diff.add_argument("--source", default=None, help="desired topology path (default: staged fleet.yml)")
    p_diff.set_defaults(func=cmd_diff)

    p_apply = sub.add_parser(
        "apply",
        help=(
            "apply pending config with minimal ops (falls back to full rebuild);"
            " exit 2 if all-noop with unresolved drift"
        ),
    )
    p_apply.add_argument("--plan", action="store_true", help="print the classified plan as JSON and exit")
    p_apply.add_argument("--allow-data-loss", action="store_true", help="permit per-node disk recreate")
    p_apply.add_argument(
        "--source", default=None, help="desired topology path for --plan and apply (default: staged fleet.yml)"
    )
    p_apply.set_defaults(func=cmd_apply)

    p_node = sub.add_parser("node", help="per-node lifecycle verbs: up | down | restart | undefine (vm mode only)")
    node_sub = p_node.add_subparsers(dest="verb", required=True)
    node_verbs = {
        "up": "render + wire one node into libvirt/ipmi_sim/sushy and power it on",
        "down": "power one node off and stop its BMC daemons (domain + overlays preserved)",
        "restart": "power-cycle one node (destroy if running, then full per-node setup)",
        "undefine": (
            "tear one node down and undefine its domain (overlays preserved unless --purge); "
            "the applied manifest is untouched — restore with `node up`"
        ),
    }
    for verb, verb_help in node_verbs.items():
        p_verb = node_sub.add_parser(verb, help=verb_help)
        p_verb.add_argument("node", help="node name or index")
        p_verb.add_argument("--json", action="store_true", help="print a NodeOpResult JSON envelope to stdout")
        if verb == "undefine":
            p_verb.add_argument(
                "--purge", action="store_true", help="also delete the node's overlays/NVRAM/sushy config"
            )
        p_verb.set_defaults(func=cmd_node)

    p_verify = sub.add_parser(
        "verify",
        help="check the applied fleet's live domains/BMC daemons (vm mode); --heal repairs healable findings",
    )
    p_verify.add_argument("--heal", action="store_true", help="repair healable findings, then re-verify")
    p_verify.add_argument("--json", action="store_true", help="print a FleetVerifyReport JSON envelope to stdout")
    p_verify.set_defaults(func=cmd_verify)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
