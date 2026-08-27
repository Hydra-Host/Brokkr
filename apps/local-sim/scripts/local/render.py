from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from local.config import get_settings
from local.derived import (
    effective_node_ip,
    extra_disk_serial,
    extra_disk_wwn,
    managed_tag_for_slot,
    node_serial,
    node_uuid,
    node_wwn,
)
from local.host_os import domain_type, host_os
from local.pxe import kernel_ipxe_path
from local.schema import Fleet, Node


def _env(templates_dir: Path) -> Environment:
    return Environment(
        loader=FileSystemLoader(str(templates_dir)),
        undefined=StrictUndefined,
        trim_blocks=False,
        lstrip_blocks=False,
        keep_trailing_newline=True,
        # Escape XML metacharacters in fleet-derived strings so a value like `evil</name>` can't
        # inject domain XML. Keyed on `.xml`/`.j2`; default_for_string=False keeps ad-hoc strings raw.
        autoescape=select_autoescape(enabled_extensions=("xml", "j2"), default_for_string=False),
    )


def _parse_pci(addr: str) -> dict[str, str]:
    """Split a host PCI address (0000:01:00.0) into libvirt <address> hex fields."""
    domain, bus, rest = addr.split(":")
    slot, func = rest.split(".")
    return {"domain": f"0x{domain}", "bus": f"0x{bus}", "slot": f"0x{slot}", "function": f"0x{func}"}


PCI_SYSFS_ROOT = Path("/sys/bus/pci/devices")


def scsi_suffix(index: int) -> str:
    """Map a 0-based extra-SCSI-disk index to a Linux ``sdX`` suffix, skipping ``sda`` (OS disk).

    Bijective base-26 for the overflow (0→b … 24→z, 25→aa …); naive chr() emitted invalid names at 25+.
    """
    n = index + 2  # bijective base-26: a=1; reserve 'a' (sda), so index 0 -> 2 -> 'b'
    chars: list[str] = []
    while n > 0:
        n, rem = divmod(n - 1, 26)
        chars.append(chr(ord("a") + rem))
    return "".join(reversed(chars))


def _pci_class(bdf: str, sysfs_root: Path) -> str:
    try:
        return (sysfs_root / bdf / "class").read_text().strip()
    except OSError:
        return ""


def _iommu_group_members(addr: str, sysfs_root: Path = PCI_SYSFS_ROOT) -> list[str]:
    """Assignable PCI endpoints sharing ``addr``'s IOMMU group (incl. ``addr``), sorted; ``[addr]`` if unreadable.

    VFIO binds a group as a unit (a GPU's audio sibling must be passed too or "group not viable");
    PCI bridges (0x06xxxx) dropped.
    """
    try:
        members = sorted(p.name for p in (sysfs_root / addr / "iommu_group" / "devices").iterdir())
    except OSError:
        return [addr]
    endpoints = [m for m in members if not _pci_class(m, sysfs_root).startswith("0x06")]
    return endpoints or [addr]


def expand_passthrough(addrs: list[str], sysfs_root: Path = PCI_SYSFS_ROOT) -> list[str]:
    """Expand each passthrough address to its full IOMMU group, order-stable + deduped."""
    out: list[str] = []
    for addr in addrs:
        for member in _iommu_group_members(addr, sysfs_root):
            if member not in out:
                out.append(member)
    return out


def render_domain(
    fleet: Fleet,
    node: Node,
    templates_dir: Path,
    overlay_path: str,
    console_log_path: str,
    console_tcp_port: int,
    vmnet_socket_path: str,
    emulator_path: str | None = None,
    host_os_override: str | None = None,
    host_arch_override: str | None = None,
    accel_override: str | None = None,
) -> str:
    """Render a libvirt domain XML for one sim node (PXE-boot variant).

    ``<kernel>`` is an iPXE binary qemu direct-loads; ``<initrd>``/``<cmdline>`` absent.
    """
    s = get_settings()
    h_os = host_os_override if host_os_override is not None else host_os()
    h_arch = host_arch_override if host_arch_override is not None else _detect_arch()
    accel = accel_override if accel_override is not None else _detect_accel()
    # Extra disks split by transport: ssd/hdd → virtio-scsi <disk>; nvme → emulated NVMe via
    # qemu:commandline (libvirt has no bus='nvme'). Overlay name uses index i to match fleet.py.
    scsi_disks: list[dict] = []
    nvme_disks: list[dict] = []
    for i, d in enumerate(node.disks):
        path = f"{s.state.overlay_root}/{node.name}-d{i}.img"
        serial = extra_disk_serial(node.ipmi_mac, i)
        if d.type == "nvme":
            # Pin to a high pcie.0 slot: libvirt auto-allocates root ports from low slots and
            # doesn't know this qemu:commandline device, so an unaddressed nvme collides at slot 1.
            nvme_disks.append(
                {
                    "id": f"nvm{len(nvme_disks)}",
                    "path": path,
                    "serial": serial,
                    "addr": f"0x{0x10 + len(nvme_disks):02x}",
                }
            )
        else:
            scsi_disks.append(
                {
                    "dev": f"sd{scsi_suffix(len(scsi_disks))}",
                    "path": path,
                    "serial": serial,
                    "wwn": extra_disk_wwn(node.ipmi_mac, i),
                    "ssd": d.type == "ssd",
                }
            )
    # Extra data NICs (Linux-only): plain virtio ports on br-brokkr with no <address> so libvirt
    # auto-allocates a free slot (avoids the nvme pcie.0 0x10+ pins). Blank L2 for guest bonds/VLANs.
    extra_nics = [{"mac": nic.mac, "model": nic.model, "mtu": nic.mtu, "link": nic.link} for nic in node.nics]
    ctx = {
        "node": node,
        "data_mtu": node.data_mtu,
        "data_bridge": s.paths.data_bridge,
        "managed_tag": managed_tag_for_slot(s.sim.slot),
        "extra_nics": extra_nics,
        "uuid": node_uuid(node.ipmi_mac),
        "overlay_path": overlay_path,
        "console_log_path": console_log_path,
        "console_tcp_port": console_tcp_port,
        "vmnet_socket_path": vmnet_socket_path,
        "emulator_path": emulator_path if emulator_path is not None else str(s.paths.qemu_emulator),
        "ipxe_path": str(kernel_ipxe_path(fleet, node)),
        "disk_serial": node_serial(node.ipmi_mac),
        "disk_wwn": node_wwn(node.ipmi_mac),
        "extra_disks": scsi_disks,
        "nvme_disks": nvme_disks,
        "passthrough": [_parse_pci(addr) for addr in expand_passthrough(node.passthrough)],
        "edk2_code_path": s.paths.edk2_code_path,
        "edk2_vars_template_path": s.paths.edk2_vars_template_path,
        "nvram_path": f"{s.state.nvram_root}/{node.name}.fd",
        "host_os": h_os,
        "host_arch": h_arch,
        "accel": accel,
        "domain_type": domain_type(accel),
        # TCG cannot pass the host CPU through, and on aarch64 `maximum` is what keeps -M virt off
        # its 32-bit cortex-a15 default, which cannot run the aarch64 EDK2 firmware.
        "cpu_mode": "maximum" if accel == "tcg" else "host-passthrough",
        "domain_arch": "aarch64" if h_arch == "arm64" else "x86_64",
        "machine": "virt" if h_arch == "arm64" else "q35",
    }
    return _env(templates_dir).get_template("domain.xml.j2").render(**ctx)


def _detect_arch() -> str:
    """Wrap host_os.host_arch() so tests can override via host_arch_override."""
    from local.host_os import host_arch

    return host_arch()


def _detect_accel() -> str:
    """Wrap host_os.detect_accel() so one monkeypatch neutralizes the libvirt probe."""
    from local.host_os import detect_accel

    return detect_accel()


def render_bootptab_section(fleet: Fleet, slot: int) -> str:
    """One stack's marker-wrapped slice of ``/etc/bootptab`` — install/remove touches only the
    lines between its own ``# >>> brokkr-slot-<S>`` / ``# <<< brokkr-slot-<S>`` pair."""
    lines = [f"# >>> brokkr-slot-{slot}"]
    for index, node in enumerate(fleet.nodes):
        ip = effective_node_ip(node, fleet.network.cidr, index)
        lines.append(f"{node.name}\t1\t{node.data_mac}\t{ip}")
    lines.append(f"# <<< brokkr-slot-{slot}")
    return "\n".join(lines) + "\n"
