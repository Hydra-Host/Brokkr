import re
from pathlib import Path
from xml.etree import ElementTree

from local.render import render_domain, scsi_suffix
from local.schema import Fleet

TEMPLATES_DIR = Path(__file__).parent.parent / "templates"


def _fleet(arch: str = "aarch64", dhcp: bool = False):
    network: dict[str, object] = {
        "name": "brokkr-net",
        "cidr": "192.168.200.0/24",
        "domain": "sim.local",
        "bmc_cidr": "192.168.105.0/24",
    }
    if dhcp:
        network["dhcp"] = True
    return Fleet.model_validate(
        {
            "network": network,
            "defaults": {
                "cpus": 2,
                "memory_mb": 4096,
                "disk_gb": 40,
                "arch": arch,
                "bmc": {"username": "admin", "password": "admin"},
            },
            "nodes": [
                {
                    "name": "gpu-1",
                    "ipmi_mac": "52:54:00:bc:00:01",
                    "data_mac": "52:54:00:da:00:01",
                },
            ],
        }
    )


def _render(
    fleet,
    overlay="/tmp/test.img",
    console="/tmp/test.log",
    vmnet_socket="/tmp/socket_vmnet.sock",
    emulator="/opt/homebrew/bin/qemu-system-aarch64",
):
    return render_domain(
        fleet,
        fleet.nodes[0],
        TEMPLATES_DIR,
        overlay_path=overlay,
        console_log_path=console,
        console_tcp_port=9300,
        vmnet_socket_path=vmnet_socket,
        emulator_path=emulator,
        host_os_override="macos",
        host_arch_override="arm64",
    )


def test_domain_xml_has_name_and_uuid():
    xml = _render(_fleet())
    assert "<name>gpu-1</name>" in xml
    assert "<uuid>" in xml


def test_domain_xml_carries_the_legacy_managed_tag_at_slot_0():
    assert ">brokkr-local<" in _render(_fleet())


def test_domain_xml_carries_the_slot_managed_tag(monkeypatch):
    from local import render as render_mod

    monkeypatch.setattr(render_mod, "managed_tag_for_slot", lambda slot: "brokkr-local-s9")
    assert ">brokkr-local-s9<" in _render(_fleet())


def test_domain_xml_escapes_fleet_string_metacharacters():
    evil_path = "/tmp/lo<g>&'\".log"
    xml = _render(_fleet(), console=evil_path)
    root = ElementTree.fromstring(xml)
    log_el = root.find(".//log")
    assert log_el is not None
    assert log_el.get("file") == evil_path
    assert "lo&lt;g&gt;&amp;" in xml
    assert "<g>" not in xml


def test_domain_uses_hvf_acceleration():
    xml = _render(_fleet())
    assert "<domain type='hvf'" in xml
    assert "<type arch='aarch64' machine='virt'>hvm</type>" in xml
    assert "/opt/homebrew/bin/qemu-system-aarch64" in xml


def test_domain_xml_has_memory_and_cpus():
    xml = _render(_fleet())
    assert "<memory unit='MiB'>4096</memory>" in xml
    assert "<vcpu placement='static'>2</vcpu>" in xml


def test_kernel_points_at_per_vm_ipxe_binary():
    xml = _render(_fleet())
    assert "<kernel>" in xml
    assert "ipxe-gpu-1.efi</kernel>" in xml
    assert "<initrd>" not in xml
    assert "<cmdline>" not in xml


def test_os_disk_is_virtio_scsi_presented_as_ssd():
    xml = _render(_fleet(), overlay="/var/lib/local/disks/overlays/gpu-1.img")
    assert "<controller type='scsi' index='0' model='virtio-scsi'/>" in xml
    assert "<source file='/var/lib/local/disks/overlays/gpu-1.img'/>" in xml
    assert "<target dev='sda' bus='scsi' rotation_rate='1'/>" in xml
    assert "<driver name='qemu' type='raw' discard='unmap' detect_zeroes='unmap'/>" in xml


def test_uefi_firmware_loaded_passively():
    from local.config import get_settings

    s = get_settings()
    xml = _render(_fleet())
    assert f"<loader readonly='yes' type='pflash' format='raw'>{s.paths.edk2_code_path}</loader>" in xml
    assert f"<nvram template='{s.paths.edk2_vars_template_path}'>" in xml


def test_os_disk_advertises_serial_and_wwn():
    xml = _render(_fleet())
    assert "<serial>SIM525400BC0001</serial>" in xml
    assert "<wwn>0x500525400bc00010</wwn>" in xml


def test_no_iso_attached_under_pxe_boot():
    xml = _render(_fleet())
    assert "brokkr-discovery.iso" not in xml
    assert "<target dev='vdb'" not in xml
    assert "<readonly/>" not in xml
    assert xml.count("<disk type='file' device='disk'>") == 1


def test_console_serial_is_telnet_with_log():
    xml = _render(_fleet(), console="/tmp/local/logs/gpu-1.log")
    assert "<serial type='tcp'>" in xml
    assert "<source mode='bind' host='127.0.0.1' service='9300'/>" in xml
    assert "<protocol type='telnet'/>" in xml
    assert "<log file='/tmp/local/logs/gpu-1.log' append='on'/>" in xml


def test_data_plane_via_socket_vmnet_pci():
    xml = _render(_fleet(), vmnet_socket="/var/run/socket_vmnet.data.sock")
    assert "xmlns:qemu='http://libvirt.org/schemas/domain/qemu/1.0'" in xml
    assert "<qemu:commandline>" in xml
    assert "stream,id=net0,addr.type=unix,addr.path=/var/run/socket_vmnet.data.sock" in xml
    assert "addr.path=/var/run/socket_vmnet.data.sock,reconnect-ms=1000" in xml
    assert "virtio-net-pci,netdev=net0,mac=52:54:00:da:00:01,bus=pcie.0,addr=0x2" in xml
    assert "virtio-net-device" not in xml
    assert "mac=52:54:00:bc:00:01" not in xml


def _render_linux(fleet, **kwargs):
    return render_domain(
        fleet,
        fleet.nodes[0],
        TEMPLATES_DIR,
        overlay_path=kwargs.get("overlay", "/tmp/test.img"),
        console_log_path=kwargs.get("console", "/tmp/test.log"),
        console_tcp_port=kwargs.get("console_tcp_port", 9300),
        vmnet_socket_path=kwargs.get("vmnet_socket", "/unused/on/linux"),
        emulator_path="/usr/bin/qemu-system-x86_64",
        host_os_override="linux",
        host_arch_override="amd64",
    )


def test_linux_domain_uses_kvm_q35():
    xml = _render_linux(_fleet())
    assert "<domain type='kvm'" in xml
    assert "<type arch='x86_64' machine='q35'>hvm</type>" in xml
    assert "/usr/bin/qemu-system-x86_64" in xml
    assert "<domain type='hvf'" not in xml


def test_linux_uses_l2_bridge_not_socket_vmnet():
    xml = _render_linux(_fleet())
    assert "<interface type='bridge'>" in xml
    assert "source bridge='br-brokkr'" in xml
    assert "<mac address='52:54:00:da:00:01'/>" in xml
    assert "<qemu:commandline>" not in xml
    assert "socket_vmnet" not in xml
    assert "addr.type=unix" not in xml


def test_linux_domain_opts_out_of_per_vm_apparmor():
    xml = _render_linux(_fleet())
    assert "<seclabel type='none'/>" in xml


def test_macos_domain_has_no_seclabel():
    xml = _render(_fleet())
    assert "<seclabel" not in xml


def test_linux_disk_presentation_identical_to_macos():
    xml = _render_linux(_fleet())
    assert "<controller type='scsi' index='0' model='virtio-scsi'/>" in xml
    assert "rotation_rate='1'" in xml
    assert "discard='unmap'" in xml


def _fleet_nics():
    return Fleet.model_validate(
        {
            "network": {
                "name": "brokkr-net",
                "cidr": "192.168.200.0/24",
                "domain": "sim.local",
                "bmc_cidr": "192.168.105.0/24",
            },
            "nodes": [
                {
                    "name": "gpu-1",
                    "ipmi_mac": "52:54:00:bc:00:01",
                    "data_mac": "52:54:00:da:00:01",
                    "data_mtu": 9000,
                    "nics": [
                        {"mac": "52:54:00:ee:00:01", "model": "e1000e", "mtu": 9000, "link": "down"},
                        {"mac": "52:54:00:ee:00:02", "model": "virtio"},
                    ],
                },
            ],
        }
    )


def test_linux_extra_nics_rendered():
    xml = _render_linux(_fleet_nics())
    assert "<mac address='52:54:00:ee:00:01'/>" in xml
    assert "<model type='e1000e'/>" in xml
    assert "<mac address='52:54:00:ee:00:02'/>" in xml
    assert "<mac address='52:54:00:da:00:01'/>" in xml
    assert "<mtu size='9000'/>" in xml
    assert "<link state='down'/>" in xml
    assert xml.count("source bridge='br-brokkr'") == 3
    assert "<vlan>" not in xml


def _fake_sysfs(tmp_path, groups):
    root = tmp_path / "devices"
    for members in groups.values():
        bdfs = [bdf for bdf, _ in members]
        for bdf, cls in members:
            devices = root / bdf / "iommu_group" / "devices"
            devices.mkdir(parents=True, exist_ok=True)
            (root / bdf / "class").write_text(cls + "\n")
            for member in bdfs:
                (devices / member).mkdir(exist_ok=True)
    return root


def test_passthrough_expands_to_full_iommu_group(tmp_path):
    from local.render import expand_passthrough

    root = _fake_sysfs(
        tmp_path,
        {
            "15": [
                ("0000:81:00.0", "0x030000"),
                ("0000:81:00.1", "0x040300"),
                ("0000:80:01.1", "0x060400"),
            ],
        },
    )
    assert expand_passthrough(["0000:81:00.0"], sysfs_root=root) == ["0000:81:00.0", "0000:81:00.1"]


def test_passthrough_unknown_device_passes_through_unchanged(tmp_path):
    from local.render import expand_passthrough

    root = _fake_sysfs(tmp_path, {})
    assert expand_passthrough(["0000:01:00.0"], sysfs_root=root) == ["0000:01:00.0"]


def test_scsi_suffix_single_letter_range_matches_legacy():
    for i in range(25):
        assert scsi_suffix(i) == chr(ord("b") + i)
    assert scsi_suffix(0) == "b"
    assert scsi_suffix(24) == "z"


def test_scsi_suffix_overflows_to_bijective_base26():
    assert scsi_suffix(25) == "aa"
    assert scsi_suffix(26) == "ab"
    assert scsi_suffix(50) == "az"
    assert scsi_suffix(51) == "ba"


def _fleet_many_disks(n: int, disk_type: str = "ssd"):
    return Fleet.model_validate(
        {
            "network": {
                "name": "brokkr-net",
                "cidr": "192.168.200.0/24",
                "domain": "sim.local",
                "bmc_cidr": "192.168.105.0/24",
            },
            "nodes": [
                {
                    "name": "gpu-1",
                    "ipmi_mac": "52:54:00:bc:00:01",
                    "data_mac": "52:54:00:da:00:01",
                    "disks": [{"size_gb": 40, "type": disk_type} for _ in range(n)],
                },
            ],
        }
    )


def test_extra_scsi_disks_past_sdz_render_valid_target_names():
    xml = _render(_fleet_many_disks(30))
    ElementTree.fromstring(xml)

    devs = re.findall(r"<target dev='(sd[^']*)'", xml)
    assert devs[0] == "sda"
    extra = devs[1:]
    assert len(extra) == 30
    for dev in extra:
        assert re.fullmatch(r"sd[a-z]+", dev), dev
    assert extra[0] == "sdb"
    assert extra[24] == "sdz"
    assert extra[25] == "sdaa"
    assert extra[26] == "sdab"


def test_kernel_points_at_shared_dhcp_image_in_dhcp_mode():
    xml = _render(_fleet(dhcp=True))
    assert "ipxe-dhcp.efi</kernel>" in xml
    assert "ipxe-gpu-1.efi" not in xml


def test_kernel_points_at_per_vm_binary_in_static_mode():
    xml = _render(_fleet())
    assert "ipxe-gpu-1.efi</kernel>" in xml
    assert "ipxe-dhcp.efi" not in xml
