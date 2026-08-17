"""Build the GRUB boot-from-disk binaries the bridge serves at ``/api/grub``.

Built in one ``linux/amd64`` Docker container (grub-mkstandalone + arm64 modules
aren't on macOS) emitting every target; idempotent on grub-cfg mtime.
"""

from __future__ import annotations

from pathlib import Path

from local.config import get_settings
from local.logger import log
from local.process_utils import ensure_docker_running, run_streamed

# file_serve_service maps (arch, platform) → these under assets/download/grub/:
# (amd64,efi)=bootx64.efi (arm64,efi)=bootaa64.efi (amd64,pcbios)=core.img.
_OUTPUTS = ("bootx64.efi", "bootaa64.efi", "core.img")
_BUILD_SCRIPT = Path(__file__).resolve().parent / "grub-build.sh"


class GrubBuildError(RuntimeError):
    pass


def grub_output_dir() -> Path:
    return get_settings().bridge.api_repo / "apps/bridge/assets/download/grub"


def build_grub_binaries(force: bool = False) -> bool:
    """Build bootx64.efi + bootaa64.efi + core.img into the bridge's serve dir; True if a build ran."""
    cfg_dir = get_settings().bridge.api_repo / "apps/bridge/boot/grub"
    if not cfg_dir.is_dir():
        raise GrubBuildError(f"grub cfgs not found at {cfg_dir}. Set HUB_REPO_PATH to your checkout.")

    out_dir = grub_output_dir()
    outputs = [out_dir / name for name in _OUTPUTS]
    newest_cfg = max((c.stat().st_mtime for c in cfg_dir.glob("grub-*.cfg")), default=0.0)
    if not force and all(o.exists() for o in outputs) and min(o.stat().st_mtime for o in outputs) >= newest_cfg:
        log.skip(f"grub binaries up-to-date in {out_dir}")
        return False

    ensure_docker_running()
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info("build grub binaries (docker amd64: bootx64.efi + bootaa64.efi + core.img)")
    run_streamed(
        "docker",
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        f"{cfg_dir}:/cfg:ro",
        "-v",
        f"{out_dir}:/export",
        "-v",
        f"{_BUILD_SCRIPT}:/build.sh:ro",
        get_settings().paths.build_base_image,
        "bash",
        "/build.sh",
        prefix="[build-grub] ",
    )
    log.success(f"grub binaries → {out_dir}")
    return True


if __name__ == "__main__":
    build_grub_binaries(force=True)
