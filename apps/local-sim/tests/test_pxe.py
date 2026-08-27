from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
from local import pxe
from local.schema import Fleet


def _fleet(arch: str = "aarch64", dhcp: bool = False) -> Fleet:
    return Fleet.model_validate(
        {
            "network": {
                "name": "brokkr-net",
                "cidr": "192.168.200.0/24",
                "domain": "sim.local",
                "bmc_cidr": "192.168.105.0/24",
                "dhcp": dhcp,
            },
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


def _completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


@pytest.fixture(autouse=True)
def _skip_docker_precheck(monkeypatch):
    monkeypatch.setattr(pxe.process_utils, "ensure_docker_running", lambda: None)
    monkeypatch.setattr(pxe.process_utils, "ensure_docker_buildx", lambda: None)


def test_build_routes_docker_through_process_utils_run_streamed(monkeypatch, tmp_path):
    fleet = _fleet()
    node = fleet.nodes[0]
    monkeypatch.setattr(pxe, "ipxe_binary_path", lambda _n: tmp_path / "boot" / "ipxe-gpu-1.efi")
    monkeypatch.setattr(pxe, "_embed_script", lambda *a, **k: "#!ipxe\n")

    captured = {}

    def fake_run(*cmd, **kw):
        captured["cmd"] = cmd
        captured["kw"] = kw
        dest = next(c for c in cmd if str(c).startswith("type=local,dest="))
        out_dir = str(dest).split("dest=", 1)[1]
        built = Path(out_dir) / "ipxe.efi"
        built.parent.mkdir(parents=True, exist_ok=True)
        built.write_bytes(b"EFI")
        return _completed(0)

    monkeypatch.setattr(pxe.process_utils, "run_streamed", fake_run)

    out = pxe.build_ipxe_for_node(fleet, node)

    assert out.is_file()
    cmd = captured["cmd"]
    assert cmd[:3] == ("docker", "buildx", "build")
    assert captured["kw"]["check"] is False
    assert captured["kw"]["prefix"] == "[build-ipxe gpu-1] "
    assert "--progress=plain" in cmd
    assert "cwd" in captured["kw"] and captured["kw"]["cwd"]
    idx = cmd.index("BASE_IMAGE=ubuntu:24.04")
    assert cmd[idx - 1] == "--build-arg"


def test_vm_reachable_bridge_url_uses_passed_cidr_gateway(monkeypatch):
    class _Bridge:
        endpoint = "http://127.0.0.1:8000"

    class _Settings:
        bridge = _Bridge()

    monkeypatch.setattr(pxe, "get_settings", lambda: _Settings())
    assert pxe._vm_reachable_bridge_url("192.168.200.0/24") == "http://192.168.200.1:8000"


def test_build_raises_runtime_error_on_nonzero(monkeypatch, tmp_path):
    fleet = _fleet()
    node = fleet.nodes[0]
    monkeypatch.setattr(pxe, "ipxe_binary_path", lambda _n: tmp_path / "boot" / "ipxe-gpu-1.efi")
    monkeypatch.setattr(pxe, "_embed_script", lambda *a, **k: "#!ipxe\n")
    monkeypatch.setattr(
        pxe.process_utils,
        "run_streamed",
        lambda *a, **k: _completed(1, stdout="out"),
    )
    with pytest.raises(RuntimeError, match="iPXE build failed"):
        pxe.build_ipxe_for_node(fleet, node)


def test_embed_script_bakes_nonempty_ipmi_identifiers(monkeypatch):
    fleet = _fleet()
    node = fleet.nodes[0]
    monkeypatch.setattr(pxe, "_vm_reachable_bridge_url", lambda *a, **k: "http://192.168.200.1:8000")
    script = pxe._embed_script(fleet, node)
    assert "param ipmi_mac 52:54:00:bc:00:01\n" in script
    assert "${ipmi/mac}" not in script and "${ipmi/ip}" not in script
    m = re.search(r"param ipmi_ip (\S+)\n", script)
    assert m and m.group(1).startswith("192.168.105.")


def test_failed_build_does_not_advance_cache_key(monkeypatch, tmp_path):
    fleet = _fleet()
    node = fleet.nodes[0]
    out = tmp_path / "boot" / "ipxe-gpu-1.efi"
    monkeypatch.setattr(pxe, "ipxe_binary_path", lambda _n: out)
    monkeypatch.setattr(pxe, "_embed_script", lambda *a, **k: "#!ipxe NEW\n")
    monkeypatch.setattr(pxe.process_utils, "run_streamed", lambda *a, **k: _completed(1, stderr="boom"))
    with pytest.raises(RuntimeError):
        pxe.build_ipxe_for_node(fleet, node)
    assert not out.with_suffix(".ipxe").is_file()


def test_kernel_ipxe_path_selects_by_dhcp_mode():
    static_fleet = _fleet(dhcp=False)
    dhcp_fleet = _fleet(dhcp=True)
    node = static_fleet.nodes[0]
    assert pxe.kernel_ipxe_path(static_fleet, node) == pxe.ipxe_binary_path(node)
    assert pxe.kernel_ipxe_path(dhcp_fleet, node) == pxe.ipxe_dhcp_image_path(node.arch)
    assert pxe.ipxe_dhcp_image_path(node.arch).name == "ipxe-dhcp.efi"


def test_embed_script_dhcp_is_generic(monkeypatch):
    monkeypatch.setattr(pxe, "_vm_reachable_bridge_url", lambda *a, **k: "http://192.168.200.1:8000")
    script = pxe._embed_script_dhcp(_fleet(arch="x86_64", dhcp=True), "x86_64")
    assert "\ndhcp net0 || dhcp ||" in script
    assert "set net0/ip " not in script
    assert "param mac ${net0/mac:hexhyp}\n" in script
    assert "param buildarch amd64\n" in script
    assert "chain --autofree ${base}/api/chain##params" in script
    assert "${ipmi/mac}" in script


def test_embed_script_dhcp_bakes_buildarch_per_arch(monkeypatch):
    monkeypatch.setattr(pxe, "_vm_reachable_bridge_url", lambda *a, **k: "http://192.168.200.1:8000")
    x86 = pxe._embed_script_dhcp(_fleet(arch="x86_64", dhcp=True), "x86_64")
    assert "param buildarch amd64\n" in x86
    arm = pxe._embed_script_dhcp(_fleet(arch="aarch64", dhcp=True), "aarch64")
    assert "param buildarch arm64\n" in arm
    assert "param buildarch amd64" not in arm


def test_build_ipxe_dhcp_image_routes_buildx_with_arch_label(monkeypatch, tmp_path):
    fleet = _fleet(arch="aarch64", dhcp=True)
    monkeypatch.setattr(pxe, "ipxe_dhcp_image_path", lambda _arch: tmp_path / "boot" / "ipxe-dhcp.efi")
    monkeypatch.setattr(pxe, "_embed_script_dhcp", lambda *a, **k: "#!ipxe\n")

    captured = {}

    def fake_run(*cmd, **kw):
        captured["cmd"] = cmd
        captured["kw"] = kw
        dest = next(c for c in cmd if str(c).startswith("type=local,dest="))
        built = Path(str(dest).split("dest=", 1)[1]) / "ipxe.efi"
        built.parent.mkdir(parents=True, exist_ok=True)
        built.write_bytes(b"EFI")
        return _completed(0)

    monkeypatch.setattr(pxe.process_utils, "run_streamed", fake_run)

    out = pxe.build_ipxe_dhcp_image(fleet, "aarch64")

    assert out.is_file()
    assert captured["kw"]["prefix"] == "[build-ipxe dhcp-aarch64] "
    assert "linux/arm64" in captured["cmd"]
