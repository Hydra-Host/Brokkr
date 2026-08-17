"""Per-VM iPXE binaries direct-loaded via libvirt ``<kernel>`` — the sim shortcuts firmware/TFTP by
loading iPXE as the kernel; from iPXE onward the chain (DHCP, HTTP fetch, casper netboot) matches prod."""

from __future__ import annotations

import ipaddress
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from local import process_utils
from local.config import get_settings
from local.derived import arch_url_segment, bmc_ip, effective_node_ip
from local.logger import log
from local.schema import Fleet, Node
from local.zones import http_port


def ipxe_binary_path(node: Node) -> Path:
    """Per-VM iPXE binary path (static mode). Must agree with what render.py writes into <kernel>."""
    return get_settings().state.boot_artifact_root / node.arch / f"ipxe-{node.name}.efi"


def ipxe_dhcp_image_path(arch: str) -> Path:
    """Generic DHCP-mode iPXE image — ONE per arch, shared by every node of that arch."""
    return get_settings().state.boot_artifact_root / arch / "ipxe-dhcp.efi"


def kernel_ipxe_path(fleet: Fleet, node: Node) -> Path:
    """Select the ``<kernel>`` iPXE binary — shared DHCP image or per-VM static binary, per ``fleet.network.dhcp``."""
    if fleet.network.dhcp:
        return ipxe_dhcp_image_path(node.arch)
    return ipxe_binary_path(node)


def _vm_reachable_bridge_url(cidr: str, port_ordinal: int = 0) -> str:
    """Translate ``bridge.endpoint`` (Mac loopback) into the VM's perspective: the Mac is the
    data-plane gateway (``<cidr>.1``). ``port_ordinal`` shifts the port to the node's zone spoke
    block (0 == ``<gw>:8000``)."""
    s = get_settings()
    endpoint = s.bridge.endpoint
    parsed = urlsplit(endpoint)
    base_port = parsed.port or 8000
    zone_port = http_port(port_ordinal, base=base_port)
    if "127.0.0.1" not in endpoint and "localhost" not in endpoint:
        # Non-loopback endpoint: only retarget the port for non-primary zones.
        if port_ordinal == 0:
            return endpoint
        host = parsed.hostname or ""
        return urlunsplit((parsed.scheme, f"{host}:{zone_port}", parsed.path, parsed.query, parsed.fragment))
    gw = str(ipaddress.ip_network(cidr, strict=False).network_address + 1)
    return urlunsplit((parsed.scheme or "http", f"{gw}:{zone_port}", parsed.path, parsed.query, parsed.fragment))


def _embed_script(fleet: Fleet, node: Node) -> str:
    idx = next(i for i, n in enumerate(fleet.nodes) if n.name == node.name)
    static_ip = effective_node_ip(node, fleet.network.cidr, idx)
    # The guest has no in-VM IPMI device (BMC is an external ipmi_sim), so iPXE's ${ipmi/*} resolve
    # empty — bake the node's BMC identity in so the hub joins this data-plane discovery to the BMC scan entry.
    node_bmc_ip = node.bmc_ip or bmc_ip(fleet.network.bmc_cidr, idx)
    network = ipaddress.ip_network(fleet.network.cidr, strict=False)
    gw = str(network.network_address + 1)
    netmask = str(network.netmask)
    base = _vm_reachable_bridge_url(fleet.network.cidr, fleet.zone_port_ordinal(node.zone))
    arch_param = "arm64" if node.arch == "aarch64" else "amd64"
    return (
        "#!ipxe\n"
        f"echo === iPXE chainload for {node.name} ===\n"
        f"set net0/ip {static_ip}\n"
        f"set net0/netmask {netmask}\n"
        f"set net0/gateway {gw}\n"
        "ifopen net0 || goto net_fail\n"
        "echo NIC up. ip=${net0/ip} gw=${net0/gateway} mac=${net0/mac}\n"
        f"set base {base}\n"
        ":start\n"
        "params\n"
        "param platform ${platform}\n"
        f"param buildarch {arch_param}\n"
        "param ip ${net0/ip}\n"
        "param mac ${net0/mac:hexhyp}\n"
        f"param serial sim-{node.name}\n"
        "param manufacturer ${manufacturer}\n"
        f"param ipmi_mac {node.ipmi_mac}\n"
        f"param ipmi_ip {node_bmc_ip}\n"
        "param ipmi_tag ${ipmi/tag}\n"
        "param board_serial ${board-serial}\n"
        "param chassis_serial ${chassis-serial}\n"
        "param system_uuid ${uuid}\n"
        "chain --autofree ${base}/api/chain##params || goto retry\n"
        ":retry\n"
        "echo *** Chainload failed; retrying in 10s\n"
        "sleep 10\n"
        "goto start\n"
        ":net_fail\n"
        "echo *** ifopen failed\n"
        "shell\n"
    )


def _ipxe_make_target(arch: str) -> str:
    """Map our arch string to iPXE's bin-* target dir."""
    return {"aarch64": "bin-arm64-efi", "x86_64": "bin-x86_64-efi"}[arch]


def _embed_script_dhcp(fleet: Fleet, arch: str) -> str:
    """Generic DHCP-mode embed script — ONE per arch, shared by every node (per-VM identity learned
    from DHCP at runtime)."""
    base = _vm_reachable_bridge_url(fleet.network.cidr, 0)
    arch_param = arch_url_segment(arch)
    return (
        "#!ipxe\n"
        "echo === brokkr sim iPXE (dhcp) ===\n"
        f"set base {base}\n"
        # :start is BEFORE dhcp so a chain/dhcp retry re-attempts DHCP — a lease that wasn't ready
        # on first boot (bridge still hydrating) is picked up on the next loop.
        ":start\n"
        "dhcp net0 || dhcp || goto dhcp_fail\n"
        # A bare `dhcp` DISCOVERs on every NIC, so a lease on a non-net0 data NIC leaves net0/ip empty
        # and would send ip=&mac= to /api/chain. Require a net0 lease; otherwise fall through to retry.
        "isset ${net0/ip} || goto dhcp_fail\n"
        "echo NIC up via dhcp. ip=${net0/ip} gw=${net0/gateway} mac=${net0/mac}\n"
        "params\n"
        "param platform ${platform}\n"
        f"param buildarch {arch_param}\n"
        "param ip ${net0/ip}\n"
        "param mac ${net0/mac:hexhyp}\n"
        "param serial ${serial}\n"
        "param manufacturer ${manufacturer}\n"
        "param ipmi_mac ${ipmi/mac}\n"
        "param ipmi_ip ${ipmi/ip}\n"
        "param ipmi_tag ${ipmi/tag}\n"
        "param board_serial ${board-serial}\n"
        "param chassis_serial ${chassis-serial}\n"
        "param system_uuid ${uuid}\n"
        "chain --autofree ${base}/api/chain##params || goto retry\n"
        ":retry\n"
        "echo *** Chainload failed; retrying in 10s\n"
        "sleep 10\n"
        "goto start\n"
        ":dhcp_fail\n"
        "echo *** DHCP failed; retrying in 5s\n"
        "sleep 5\n"
        "goto start\n"
    )


def _compile_ipxe(script: str, out: Path, arch: str, label: str) -> Path:
    """Compile ``script`` to an iPXE EFI binary via docker buildx. Idempotent: rebuilds only when the
    script bytes change (sidecar ``.ipxe`` written after ``.efi`` so a failed build doesn't advance the cache)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    script_file = out.with_suffix(".ipxe")
    if out.is_file() and script_file.is_file() and script_file.read_text() == script:
        log.skip(f"{out.name} up-to-date (embed script unchanged)")
        return out
    process_utils.ensure_docker_running()
    target = _ipxe_make_target(arch)
    log.info(f"build {out.name} via docker buildx (target={target})")
    with tempfile.TemporaryDirectory(prefix="local-ipxe-build-") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "boot.ipxe").write_text(script)
        (tmp_path / "Dockerfile").write_text(_IPXE_DOCKERFILE)
        out_dir = tmp_path / "out"
        proc = process_utils.run_streamed(
            "docker",
            "buildx",
            "build",
            "-f",
            "Dockerfile",
            "--target",
            "export",
            "--progress=plain",
            "--platform",
            f"linux/{arch_url_segment(arch)}",
            "--build-arg",
            f"TARGET={target}",
            "--build-arg",
            f"BASE_IMAGE={get_settings().paths.build_base_image}",
            "-o",
            f"type=local,dest={out_dir}",
            ".",
            prefix=f"[build-ipxe {label}] ",
            check=False,
            cwd=tmp,
        )
        built = out_dir / "ipxe.efi"
        if proc.returncode != 0 or not built.is_file():
            raise RuntimeError(
                f"iPXE build failed for {label} (rc={proc.returncode}); see the build output above.\n"
                f"--- last lines ---\n{proc.stdout}"
            )
        shutil.copy(built, out)
    script_file.write_text(script)
    log.success(f"built {out} ({out.stat().st_size} bytes)")
    return out


def build_ipxe_for_node(fleet: Fleet, node: Node) -> Path:
    """Build the per-VM static-mode iPXE binary for one node (static mode only; DHCP uses build_ipxe_dhcp_image())."""
    return _compile_ipxe(_embed_script(fleet, node), ipxe_binary_path(node), node.arch, node.name)


def build_ipxe_dhcp_image(fleet: Fleet, arch: str) -> Path:
    """Build one shared generic DHCP-mode iPXE image for an arch (per-node identity learned from DHCP at runtime)."""
    return _compile_ipxe(_embed_script_dhcp(fleet, arch), ipxe_dhcp_image_path(arch), arch, f"dhcp-{arch}")


_IPXE_DOCKERFILE = """\
# syntax=docker/dockerfile:1
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS builder
ARG TARGET
RUN apt-get -qq update && \\
    DEBIAN_FRONTEND=noninteractive apt-get install -qq -y \\
        build-essential liblzma-dev git ca-certificates
RUN git clone --depth 1 https://github.com/ipxe/ipxe.git /ipxe
WORKDIR /ipxe/src
COPY boot.ipxe /boot.ipxe
RUN make ${TARGET}/ipxe.efi EMBED=/boot.ipxe -j 4

FROM scratch AS export
ARG TARGET
COPY --from=builder /ipxe/src/${TARGET}/ipxe.efi /ipxe.efi
"""
