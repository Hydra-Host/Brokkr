"""Pure functions of fleet.yml: given a Node, CIDR, or stack slot, return an IP, UUID, tag, or
SCSI identifier. Split rule with `config.py`: depends on a Node/Fleet → here, otherwise → config.py."""

from __future__ import annotations

import ipaddress
import uuid

LOCAL_NS = uuid.UUID("5d4e0c4a-1f7c-4f4e-9c4e-1d8d2a3b4c5d")
"""Stable namespace UUID for local — generated once, never changes."""

_ARCH_URL_SEGMENT = {"x86_64": "amd64", "aarch64": "arm64"}
"""arch → bridge URL path segment (used by iPXE embed script + prefetch)."""

NODE_IP_BASE = 10
"""First host offset for node IPs on both the data plane (node_ip) and OOB/BMC plane (bmc_ip):
gpu-1 → .10. Single source; 46-prefixes imports it so the DHCP pool stays clear of reservations."""


def managed_tag_for_slot(slot: int) -> str:
    """Per-slot libvirt domain managed-tag. Slot 0 keeps the legacy ``brokkr-local`` so domains
    defined before slotting still match; each other slot sweeps only its own."""
    return "brokkr-local" if slot == 0 else f"brokkr-local-s{slot}"


def _ip_at_offset(cidr: str, offset: int) -> str:
    net = ipaddress.ip_network(cidr, strict=False)
    return str(net.network_address + offset)


def node_ip(cidr: str, index: int) -> str:
    """Data-plane IP for the N-th node, offset by 10 (gpu-1 → .10). Baked into the iPXE embed
    script as the static IP so bridge connectivity is deterministic regardless of DHCP races."""
    return _ip_at_offset(cidr, NODE_IP_BASE + index)


def effective_node_ip(node, cidr: str, index: int) -> str:
    """Node's data-plane IP: the ``node.ip`` override if set, else index-derived :func:`node_ip`.
    The single accessor every consumer must use so they agree on one IP per node (bypassing it lets
    an override desync the seeded netplan, breaking boot/SSH)."""
    return node.ip or node_ip(cidr, index)


def bmc_ip(cidr: str, index: int) -> str:
    """BMC IP for the N-th node on the OOB plane (host loopback alias), same offset rule as
    :func:`node_ip`. ipmi_sim binds each on loopback so traffic never leaves the host."""
    return _ip_at_offset(cidr, NODE_IP_BASE + index)


def effective_bmc_ip(node, bmc_cidr: str, index: int) -> str:
    """Node's BMC-plane IP: the ``node.bmc_ip`` override if set, else index-derived :func:`bmc_ip`.
    The single accessor for the ipmi_sim/sushy binds, loopback alias, seeded ``Device.ipmiIpAddress``
    and the fleet↔Hub join (bypassing it desyncs the join, which is keyed by the seeded ipmi IP)."""
    return node.bmc_ip or bmc_ip(bmc_cidr, index)


def console_tcp_port(index: int) -> int:
    """Host-loopback telnet port for the VM serial, shared by the domain XML bind and ipmi_sim's
    SOL backing so ``ipmitool sol activate`` streams the console."""
    return 9300 + index


def effective_console_port(node, index: int) -> int:
    """Node's serial-console port: the ``node.console_port`` override if set, else index-derived
    :func:`console_tcp_port`. The domain XML bind and ipmi_sim's SOL backing must agree per node."""
    return node.console_port or console_tcp_port(index)


def node_uuid(mac: str) -> str:
    """Deterministic Redfish system UUID; stable as long as the MAC is."""
    return str(uuid.uuid5(LOCAL_NS, mac.lower()))


def sim_device_uuid(index: int) -> str:
    """Predictable Hub Device.id for the sim node at ``index`` (0-based): N = index+1, so re-seeds
    keep iPXE-baked UUIDs and Hub Device rows aligned."""
    return f"00000000-0000-0000-0000-{index + 1:012d}"


def bm_device_uuid(mac: str) -> str:
    return str(uuid.uuid5(LOCAL_NS, f"baremetal:{mac.lower()}"))


def node_serial(mac: str) -> str:
    """SCSI serial for the sim node's OS disk, stable per MAC. Must match qemu's SCSI INQUIRY
    (``<serial>``); bridge correlates ``lsblk`` against ``storage_layouts.configs[].disks``."""
    return f"SIM{mac.replace(':', '').upper()}"


def node_wwn(mac: str) -> str:
    """16-hex SCSI WWN (NAA Type 5) for the sim node's OS disk, stable per MAC: ``0x5`` + 2 zero
    nibbles (vendor OUI) + 12 MAC nibbles + 1 pad, matching SCSI INQUIRY VPD page 0x83."""
    mac_hex = mac.replace(":", "").lower()
    return f"0x500{mac_hex}0"


def extra_disk_serial(mac: str, index: int) -> str:
    """SCSI serial for extra (non-OS) data disk #index (0-based). Stable per MAC+index."""
    return f"SIM{mac.replace(':', '').upper()}D{index + 1}"


def extra_disk_wwn(mac: str, index: int) -> str:
    """16-hex SCSI WWN for extra disk #index, distinct from the OS disk + each other."""
    mac_hex = mac.replace(":", "").lower()
    return f"0x5{index + 1:01x}0{mac_hex}0"


def arch_url_segment(arch: str) -> str:
    """Bridge URL path segment for the given arch (``amd64`` / ``arm64``)."""
    return _ARCH_URL_SEGMENT[arch]
