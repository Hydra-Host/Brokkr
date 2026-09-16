from __future__ import annotations

import socket
from collections.abc import Callable
from pathlib import Path

import click
import yaml
from rich.console import Console
from rich.table import Table

from local import process_utils
from local.config import get_settings
from local.derived import bm_device_uuid, effective_bmc_ip, node_uuid
from local.host_os import host_os
from local.schema import Fleet


def _virsh_domstate(name: str) -> str:
    r = process_utils.virsh("domstate", name, check=False, capture=True)
    return r.stdout.strip() if r.returncode == 0 else "undefined"


def _ipmi_sim_status(name: str) -> str:
    """Whether this node's ipmi_sim (the BMC) is up. Matched by its per-node
    lan.conf cmdline via pgrep — no sudo needed to observe a root process."""
    from local.daemons import ipmi_sim_running

    return "running" if ipmi_sim_running(name) else "stopped"


def _sushy_running(node_name: str) -> str:
    """Check if sushy-emulator is running by looking for the pidfile."""
    pidfile = get_settings().state.run_dir / f"sushy.{node_name}.pid"
    try:
        pid = int(pidfile.read_text().strip())
    except (FileNotFoundError, ValueError):
        return "stopped"
    try:
        # Signal 0: probe without killing
        import os

        os.kill(pid, 0)
        return "running"
    except ProcessLookupError:
        return "stopped"


def fleet_ready(node_names: list[str], domstate: Callable[[str], str]) -> bool:
    """True when every node's libvirt domain reports ``running`` (the ``status --ready`` probe).

    Domain-running is a sufficient, sudo-free signal: ``fleet.cmd_up`` raises if a node's
    ipmi_sim/sushy fails to start, so all-domains-running implies the BMC plane came up too.
    """
    return all(domstate(name) == "running" for name in node_names)


def bm_ready(fleet: Fleet, applied_manifest) -> bool:
    from local import applied as applied_mod

    if applied_manifest is None:
        return False
    if applied_mod.planes_of(applied_manifest.nodes, applied_manifest.bm_nodes) != (fleet.has_vm, fleet.has_bm):
        return False
    return applied_mod.diff(fleet, applied_manifest, host_os()).in_sync


def _bmc_reachable(bmc_ip: str, port: int = 443, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((bmc_ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _spoke_port() -> int:
    from urllib.parse import urlsplit

    return urlsplit(get_settings().bridge.endpoint).port or 8000


def _baked_url_drift(iface_ip: str | None) -> str:
    from local import ipxe_build

    stamped = ipxe_build._stamped_chain_url()
    if stamped is None:
        return "no bake"
    if iface_ip is None:
        return f"stale ({stamped})"
    expected = f"http://{iface_ip}:{_spoke_port()}"
    return "in-sync" if stamped == expected else f"stale ({stamped})"


def _accel_footer() -> str | None:
    """The TCG degradation footer, or None under hardware acceleration.
    Imports deferred: ``local.fleet`` loops back via ``local.verify``; ``--ready`` skips the probe."""
    from local.fleet import TCG_DEGRADATION_BRIEF
    from local.host_os import detect_accel

    return TCG_DEGRADATION_BRIEF if detect_accel() == "tcg" else None


def _print_bm_table(fleet: Fleet) -> None:
    bm = fleet.baremetal_raw
    iface_ip = process_utils.iface_ipv4(bm.iface) if bm else None
    drift = _baked_url_drift(iface_ip)

    table = Table(title=f"bare-metal fleet status (iface {bm.iface if bm else '?'} → {iface_ip or 'no ip'})")
    table.add_column("name")
    table.add_column("pxe mac")
    table.add_column("bmc ip")
    table.add_column("bmc reachable")
    table.add_column("device.id")
    table.add_column("baked url")

    for n in fleet.bm_nodes:
        table.add_row(
            n.name,
            n.pxe_mac,
            n.bmc_ip,
            "yes" if _bmc_reachable(n.bmc_ip) else "no",
            bm_device_uuid(n.pxe_mac),
            drift,
        )
    Console().print(table)


@click.command()
@click.option("--fleet", default=None, type=click.Path(exists=True))
@click.option(
    "--ready",
    "ready_check",
    is_flag=True,
    help="Exit 0 if every node's libvirt domain is running (no table) — the devenv fleet readiness probe.",
)
def main(fleet: str | None, ready_check: bool) -> None:
    """Print the fleet status table, or with --ready exit 0/1 for the readiness probe."""
    # Custom-config-first: default to the active fleet (fleet.local.yml > fleet.yml)
    # like the rest of the engine, so status reflects what's actually deployed.
    from local.config import get_settings

    fleet_path = Path(fleet) if fleet else get_settings().paths.fleet_path
    f = Fleet.model_validate(yaml.safe_load(fleet_path.read_text()))
    from local import applied

    if ready_check:
        vm_ok = not f.has_vm or fleet_ready([n.name for n in f.nodes], _virsh_domstate)
        bm_ok = not f.has_bm or bm_ready(f, applied.read())
        raise SystemExit(0 if vm_ok and bm_ok else 1)

    if f.has_vm:
        _print_vm_table(f)
    if f.has_bm:
        _print_bm_table(f)
    if (accel_footer := _accel_footer()) is not None:
        Console().print(f"[yellow]{accel_footer}[/yellow]")

    drift = applied.diff(f, applied.read(), host_os())
    if not drift.in_sync:
        Console().print(f"[yellow]{applied.drift_summary_line(drift)}[/yellow]")


def _print_vm_table(f: Fleet) -> None:
    table = Table(title="local fleet status")
    table.add_column("name")
    table.add_column("ipmi mac")
    table.add_column("data mac")
    table.add_column("bmc ip")
    table.add_column("ipmi")
    table.add_column("redfish")
    table.add_column("domain")
    table.add_column("ipmi_sim")
    table.add_column("sushy")

    for i, n in enumerate(f.nodes):
        bip = effective_bmc_ip(n, f.network.bmc_cidr, i)
        table.add_row(
            n.name,
            n.ipmi_mac,
            n.data_mac,
            bip,
            f"{bip}:623",
            f"http://{bip}:{get_settings().sim.redfish_port}/redfish/v1/Systems/{node_uuid(n.ipmi_mac)}",
            _virsh_domstate(n.name),
            _ipmi_sim_status(n.name),
            _sushy_running(n.name),
        )

    Console().print(table)


if __name__ == "__main__":
    main()
