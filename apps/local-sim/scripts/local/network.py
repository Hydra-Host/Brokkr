"""Host networking plumbing: bootptab (static MAC->IP for vmnet's bootpd),
BMC-plane loopback aliases, orphan-NIC recovery, and the Linux L2 data-plane
bridge. A leaf module — must not import from local.fleet.
"""

from __future__ import annotations

import ipaddress
import tempfile
from pathlib import Path

from local.config import get_settings
from local.host_os import host_os
from local.logger import log
from local.process_utils import run, sudo_priv, virsh
from local.render import render_bootptab_section
from local.schema import Fleet

# ===== bootptab (static MAC→IP for vmnet's bootpd, fallback only) =====

BOOTPTAB_PATH = Path("/etc/bootptab")


def bootptab_marker(slot: int) -> str:
    return f"brokkr-slot-{slot}"


def write_bootptab(fleet: Fleet) -> None:
    """Pin each fleet node's data-plane IP via macOS bootpd static bindings.

    Fallback only — normal operation uses the static netplan in ``device.netplan``
    and no DHCP fires; bootpd consults ``/etc/bootptab`` only if one does.

    Writes only this slot's marker section so concurrent stacks share /etc/bootptab.
    """
    settings = get_settings()
    section = render_bootptab_section(fleet, settings.sim.slot)
    log.info(
        f"write {BOOTPTAB_PATH} section {bootptab_marker(settings.sim.slot)} "
        f"(data plane {fleet.network.cidr} — static data_mac→IP for sim nodes)"
    )
    # stage under the sim's run dir (inside $HOME) so the helper's bootptab-install passes its
    # under-home check — the system $TMPDIR is outside $HOME (e.g. /var/folders on macOS).
    run_dir = settings.state.run_dir
    run_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=run_dir, prefix="local-bootptab-") as tmp:
        tmp.write(section)
        tmp_path = tmp.name
    try:
        sudo_priv("bootptab-section-install", bootptab_marker(settings.sim.slot), tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def remove_bootptab() -> None:
    if not BOOTPTAB_PATH.exists():
        return
    marker = bootptab_marker(get_settings().sim.slot)
    log.info(f"remove {BOOTPTAB_PATH} section {marker}")
    sudo_priv("bootptab-section-remove", marker, check=False)


def bootptab_section_present() -> bool:
    """Whether this slot's marker section is in /etc/bootptab — the file existing is not enough
    once concurrent stacks each own a section of it."""
    try:
        return f"# >>> {bootptab_marker(get_settings().sim.slot)}" in BOOTPTAB_PATH.read_text()
    except OSError:
        return False


# ===== loopback alias IPs for the BMC plane =====
# BMC-plane IPs are host-loopback aliases (lo/lo0) so ipmi_sim/sushy traffic never leaves the box.


def _lo_iface() -> str:
    """Return the loopback interface name for the host OS."""
    return "lo0" if host_os() == "macos" else "lo"


def _lo_addrs() -> str:
    """Return current loopback iface addresses as a string (best-effort, for grep)."""
    if host_os() == "macos":
        return run("ifconfig", "lo0", capture=True, check=False).stdout
    return run("ip", "-4", "addr", "show", "dev", "lo", capture=True, check=False).stdout


def add_lo_alias(ip: str) -> None:
    """Add ``ip/32`` as an alias on the host loopback iface if not already present."""
    if f"inet {ip} " in _lo_addrs() or f"inet {ip}/" in _lo_addrs():
        return
    iface = _lo_iface()
    log.info(f"alias {ip}/32 on {iface} (BMC plane — ipmi_sim binds here, never leaves the host)")
    sudo_priv("lo-add", ip)


def remove_lo_alias(ip: str) -> None:
    if f"inet {ip} " not in _lo_addrs() and f"inet {ip}/" not in _lo_addrs():
        return
    iface = _lo_iface()
    log.info(f"remove {iface} alias {ip}")
    sudo_priv("lo-del", ip, check=False)


add_lo0_alias = add_lo_alias
remove_lo0_alias = remove_lo_alias


def bmc_lo_aliases(bmc_cidr: str) -> list[str]:
    """Loopback alias IPs in the BMC plane (incl. orphans from removed nodes)."""
    import re

    net = ipaddress.ip_network(bmc_cidr, strict=False)
    ips = re.findall(r"inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)", _lo_addrs())
    return [ip for ip in ips if ipaddress.ip_address(ip) in net]


def _recover_orphaned_nics(restarted: list[str]) -> list[str]:
    """Destroy + return pre-reconnect VMs wired to a socket_vmnet inode that was replaced
    when its daemon bounced (the caller reboots them onto the live socket); skips any VM
    whose running XML already carries ``reconnect-ms=`` (qemu re-attaches on its own)."""
    downed: list[str] = []
    for name in restarted:
        if virsh("domstate", name, check=False, capture=True).stdout.strip() != "running":
            continue
        xml = virsh("dumpxml", name, check=False, capture=True).stdout
        if "reconnect-ms=" in xml:
            continue
        log.info(f"socket_vmnet for {name} was restarted under a pre-reconnect VM — power-cycling to re-attach its NIC")
        virsh("destroy", name, check=False, capture=True)
        downed.append(name)
    return downed


def ensure_data_plane_bridge(fleet: Fleet) -> None:
    """Linux only — create the flat L2 data-plane bridge ``br-brokkr``"""
    data_bridge = get_settings().paths.data_bridge
    cidr = ipaddress.ip_network(fleet.network.cidr, strict=False)
    gw_ip = str(cidr.network_address + 1)
    log.info(f"ensure L2 data-plane bridge {data_bridge} ({gw_ip}/{cidr.prefixlen})")
    sudo_priv("bridge-ensure", data_bridge, gw_ip, str(cidr.prefixlen))
    log.info(f"ensure NAT for {cidr} out the host gateway")
    sudo_priv("bridge-nat", data_bridge, str(cidr))
