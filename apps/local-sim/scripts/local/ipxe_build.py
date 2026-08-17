"""Build the iPXE EFI binaries + ISO the bridge serves via TFTP.

Rebuilds bridge-api's Dockerfile iPXE stages via one ``docker buildx --target
ipxe-export`` into ``/opt/brokkr/ipxe-builds/``; idempotent on input mtime.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from local.config import get_settings
from local.logger import log
from local.process_utils import ensure_docker_running, run

_OUTPUTS_PER_ARCH = ("ipxe.efi", "snp.efi", "snponly.efi")
_IPXE_BUILDS_DIR = Path(os.environ.get("LOCAL_IPXE_BUILDS_DIR", "/opt/brokkr/ipxe-builds"))
_STAMP_FILE = _IPXE_BUILDS_DIR / ".chain-stamp.json"
_DEFAULT_CHAIN_BASE_URL = "http://brokkr.lan:8080"

_EXPORT_TARGET = "ipxe-export"


class IpxeBuildError(RuntimeError):
    pass


def _stamped_chain_url() -> str | None:
    try:
        data = json.loads(_STAMP_FILE.read_text())
    except (OSError, ValueError):
        return None
    url = data.get("chain_base_url")
    return url if isinstance(url, str) else None


def _newest_input_mtime(spoke_repo: Path) -> float:
    ipxe_dir = spoke_repo / "apps" / "bridge" / "boot" / "ipxe"
    dockerfile = spoke_repo / "apps" / "bridge" / "Dockerfile"
    mtimes = [dockerfile.stat().st_mtime] if dockerfile.exists() else []
    if ipxe_dir.is_dir():
        for p in ipxe_dir.rglob("*"):
            if p.is_file():
                mtimes.append(p.stat().st_mtime)
    return max(mtimes) if mtimes else 0.0


def _oldest_output_mtime() -> float:
    paths: list[Path] = []
    for arch in ("amd64", "arm64"):
        for name in _OUTPUTS_PER_ARCH:
            paths.append(_IPXE_BUILDS_DIR / arch / name)
    paths.append(_IPXE_BUILDS_DIR / "ipxe.iso")
    if not all(p.exists() for p in paths):
        return 0.0
    return min(p.stat().st_mtime for p in paths)


def build_ipxe_binaries(force: bool = False, chain_base_url: str | None = None) -> bool:
    """Build iPXE EFI binaries + ISO into ``/opt/brokkr/ipxe-builds/``; True if a build ran.

    ``chain_base_url`` is baked in via ``--build-arg CHAIN_BASE_URL``; a changed URL forces a rebuild.
    """
    spoke_repo = get_settings().bridge.api_repo
    bridge_dir = spoke_repo / "apps" / "bridge"
    if not (bridge_dir / "boot" / "ipxe").is_dir():
        raise IpxeBuildError(f"apps/bridge/boot/ipxe not found at {spoke_repo}. Set HUB_REPO_PATH.")
    if not (bridge_dir / "Dockerfile").is_file():
        raise IpxeBuildError(f"apps/bridge/Dockerfile not found at {spoke_repo}. Set HUB_REPO_PATH.")

    effective_url = chain_base_url if chain_base_url is not None else _DEFAULT_CHAIN_BASE_URL
    fresh = _oldest_output_mtime() >= _newest_input_mtime(spoke_repo)
    stamp_matches = _stamped_chain_url() == effective_url
    if not force and fresh and stamp_matches:
        log.skip(f"iPXE binaries up-to-date in {_IPXE_BUILDS_DIR} (CHAIN_BASE_URL={effective_url})")
        return False

    # Always pass the sim's URL explicitly — the Dockerfile default targets the hosted nginx :443, so the
    # sim must not fall back to it (it has no TLS terminator; its endpoint is plaintext http).
    build_args = ["--build-arg", f"CHAIN_BASE_URL={effective_url}"]

    ensure_docker_running()
    for arch in ("amd64", "arm64"):
        (_IPXE_BUILDS_DIR / arch).mkdir(parents=True, exist_ok=True)

    log.info(f"build iPXE artifacts (docker buildx → {_EXPORT_TARGET})")
    with tempfile.TemporaryDirectory(prefix="ipxe-export-") as tmp:
        run(
            "docker",
            "buildx",
            "build",
            "-f",
            str(bridge_dir / "Dockerfile"),
            "--target",
            _EXPORT_TARGET,
            *build_args,
            "-o",
            f"type=local,dest={tmp}",
            str(spoke_repo),
        )
        export_root = Path(tmp) / "export"
        for arch in ("amd64", "arm64"):
            export_dir = export_root / arch
            if not export_dir.is_dir():
                raise IpxeBuildError(f"{_EXPORT_TARGET} did not produce /export/{arch}/ in output")
            for name in _OUTPUTS_PER_ARCH:
                src = export_dir / name
                if not src.is_file():
                    raise IpxeBuildError(f"{_EXPORT_TARGET} missing {name} in /export/{arch}/")
                shutil.copy2(src, _IPXE_BUILDS_DIR / arch / name)
        iso_src = export_root / "ipxe.iso"
        if not iso_src.is_file():
            raise IpxeBuildError(f"{_EXPORT_TARGET} did not produce /export/ipxe.iso")
        shutil.copy2(iso_src, _IPXE_BUILDS_DIR / "ipxe.iso")

    _STAMP_FILE.write_text(json.dumps({"chain_base_url": effective_url, "built_at": time.time()}))
    log.success(f"iPXE binaries → {_IPXE_BUILDS_DIR} (CHAIN_BASE_URL={effective_url})")
    return True


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Build the iPXE EFI binaries + ISO the bridge serves via TFTP.")
    parser.add_argument(
        "--chain-base-url",
        default=None,
        help=f"IP-literal CHAIN_BASE_URL baked into the binaries (default: {_DEFAULT_CHAIN_BASE_URL}).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild even when artifacts are up-to-date and the stamp matches.",
    )
    args = parser.parse_args(argv)
    build_ipxe_binaries(force=args.force, chain_base_url=args.chain_base_url)


if __name__ == "__main__":
    main()
