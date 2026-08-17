"""Build brokkr-live.img and bridge-agent.img — the two cpio overlays the chain script loads
alongside vmlinuz + initrd.img. Requires host cpio, a bridge-api checkout, and a built agent bundle."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from local.config import get_settings
from local.logger import log

_AGENT_BUNDLE_REL = Path(os.environ.get("BRIDGE_AGENT_BUNDLE_REL", "apps/live-agent/dist/main.js"))
_AGENT_SERVICE_REL = Path(
    os.environ.get("BRIDGE_AGENT_SERVICE_REL", "apps/live-agent/systemd/brokkr-bridge-agent.service")
)


_LIVE_SRC = "apps/bridge/boot/initrd-live"

_DHCLIENT_SHIM = """#!/bin/sh
for _a in "$@"; do
case "$_a" in -6) exit 0;; esac
done
_iface=
for _a in "$@"; do
case "$_a" in
-*) ;;
*) [ -d "/sys/class/net/$_a" ] && _iface="$_a";;
esac
done
[ -n "$_iface" ] || exit 0
exec ipconfig -t 20 "$_iface"
"""


class LiveInitrdBuildError(RuntimeError):
    pass


def _inject_dhcp_client_shim(staging: Path) -> None:
    sbin = staging / "sbin"
    sbin.mkdir(parents=True, exist_ok=True)
    shim = sbin / "dhclient"
    shim.write_text(_DHCLIENT_SHIM)
    shim.chmod(0o755)


def _check_repo() -> None:
    if not shutil.which("cpio"):
        raise LiveInitrdBuildError("`cpio` not on PATH.")
    repo = get_settings().bridge.api_repo
    if not repo.is_dir():
        raise LiveInitrdBuildError(f"brokkr-app repo not found at {repo}. Set HUB_REPO_PATH to your checkout.")


def _stage_agent_unit(service_src: Path, dest: Path) -> None:
    """Copy the agent systemd unit into the initrd, forcing sim mode on. Without
    LOCAL_SIMULATION_ENABLED the in-VM agent's public_ip collector returns the host WAN IP under sim
    NAT, so the hub misclassifies every device as NAT and blanks its IP in DCIM."""
    text = service_src.read_text()
    if "LOCAL_SIMULATION_ENABLED" not in text:
        text = text.replace(
            "[Service]\n",
            "[Service]\nEnvironment=LOCAL_SIMULATION_ENABLED=true\n",
            1,
        )
    dest.write_text(text)


def _check_agent_inputs() -> tuple[Path, Path]:
    repo = get_settings().bridge.api_repo
    bundle = repo / _AGENT_BUNDLE_REL
    if not bundle.is_file():
        raise LiveInitrdBuildError(
            f"agent bundle missing: {bundle}. Build it first: `cd {repo} && pnpm install && "
            "pnpm --filter @repo/bridge-agent-protocol build && pnpm --filter bridge-agent build`."
        )
    service = repo / _AGENT_SERVICE_REL
    if not service.is_file():
        raise LiveInitrdBuildError(f"agent systemd unit missing: {service}.")
    return bundle, service


def _newest_mtime(paths: list[Path]) -> float:
    files = [p for p in paths if p.is_file()]
    if not files:
        raise LiveInitrdBuildError("no input files found for initrd build")
    return max(p.stat().st_mtime for p in files)


def _needs_rebuild(output: Path, inputs: list[Path]) -> bool:
    if not output.is_file():
        return True
    return output.stat().st_mtime < _newest_mtime(inputs)


_AGENT_OVERLAY_PATHS = frozenset(
    {
        "brokkr/opt/brokkr/agent/main.js",
        "brokkr/etc/systemd/system/brokkr-bridge-agent.service",
    }
)


def _live_img_has_stale_agent_overlay(output: Path) -> bool:
    """True if ``brokkr-live.img`` still embeds the pre-split agent overlay (duplicated once loaded
    alongside ``bridge-agent.img``) → force rebuild. Uses ``cpio -t`` for exact entries, not a substring scan."""
    if not output.is_file():
        return False
    try:
        with open(output, "rb") as fh:
            proc = subprocess.run(
                ["cpio", "-t", "--quiet"],
                stdin=fh,
                capture_output=True,
                text=True,
                check=False,
            )
    except OSError:
        return False
    if proc.returncode != 0:
        return False
    return bool(_AGENT_OVERLAY_PATHS.intersection(proc.stdout.splitlines()))


def _cpio_pack(staging: Path, output: Path, label: str) -> None:
    rels = sorted(str(p.relative_to(staging)) for p in staging.rglob("*"))
    file_list = ("." + "\n" + "\n".join(rels) + "\n").encode()
    log.info(f"cpio pack {label} → {output}")
    with open(output, "wb") as out:
        proc = subprocess.run(
            ["cpio", "-o", "-H", "newc", "--quiet"],
            cwd=str(staging),
            input=file_list,
            stdout=out,
            stderr=subprocess.PIPE,
            check=False,
        )
    if proc.returncode != 0 or output.stat().st_size == 0:
        raise LiveInitrdBuildError(
            f"cpio failed for {label} (rc={proc.returncode}). stderr: {proc.stderr.decode(errors='replace')[:1000]}"
        )


def _live_inputs() -> list[Path]:
    repo = get_settings().bridge.api_repo
    return [p for p in (repo / _LIVE_SRC).rglob("*") if p.is_file()]


def _agent_inputs() -> list[Path]:
    repo = get_settings().bridge.api_repo
    # Path(__file__): _stage_agent_unit transforms the unit, so a change to that logic (source
    # unchanged) must still invalidate a previously built bridge-agent.img.
    return [repo / _AGENT_BUNDLE_REL, repo / _AGENT_SERVICE_REL, Path(__file__)]


def build_live_initrd(force: bool = False) -> tuple[Path, bool]:
    _check_repo()
    s = get_settings()
    s.bridge.initrd_builds_dir.mkdir(parents=True, exist_ok=True)
    output = s.bridge.brokkr_live_img

    inputs = _live_inputs()
    if not inputs:
        raise LiveInitrdBuildError("no input files found for initrd build")

    if not force and not _needs_rebuild(output, inputs) and not _live_img_has_stale_agent_overlay(output):
        return output, False

    src_dir = s.bridge.api_repo / _LIVE_SRC
    with tempfile.TemporaryDirectory(prefix="local-live-initrd-") as tmp:
        staging = Path(tmp)
        shutil.copytree(src_dir, staging, dirs_exist_ok=True, symlinks=True)
        _inject_dhcp_client_shim(staging)
        _cpio_pack(staging, output, "brokkr-live.img")

    if not output.is_file():
        raise LiveInitrdBuildError(f"{output} missing after cpio")
    return output, True


def build_bridge_agent_initrd(force: bool = False) -> tuple[Path, bool]:
    _check_repo()
    bundle, service = _check_agent_inputs()
    s = get_settings()
    s.bridge.initrd_builds_dir.mkdir(parents=True, exist_ok=True)
    output = s.bridge.bridge_agent_img

    if not force and not _needs_rebuild(output, _agent_inputs()):
        return output, False

    with tempfile.TemporaryDirectory(prefix="local-bridge-agent-") as tmp:
        staging = Path(tmp)
        agent_dest = staging / "brokkr" / "opt" / "brokkr" / "agent"
        agent_dest.mkdir(parents=True)
        shutil.copy(bundle, agent_dest / "main.js")
        svc_dest = staging / "brokkr" / "etc" / "systemd" / "system"
        svc_dest.mkdir(parents=True)
        _stage_agent_unit(service, svc_dest / "brokkr-bridge-agent.service")
        _cpio_pack(staging, output, "bridge-agent.img")

    if not output.is_file():
        raise LiveInitrdBuildError(f"{output} missing after cpio")
    return output, True


def main() -> int:
    try:
        live_out, live_rebuilt = build_live_initrd()
        agent_out, agent_rebuilt = build_bridge_agent_initrd()
    except LiveInitrdBuildError as e:
        log.error(str(e))
        return 1
    for path, rebuilt in ((live_out, live_rebuilt), (agent_out, agent_rebuilt)):
        verb = "built" if rebuilt else "up-to-date"
        log.success(f"{verb} {path} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
