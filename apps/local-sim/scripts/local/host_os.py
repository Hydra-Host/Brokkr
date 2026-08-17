"""Host-OS detection + platform-specific path resolution (macOS/HVF, Linux/KVM).

``host_os()`` is the single point of truth — branch on it, not ``platform.system()``.
"""

from __future__ import annotations

import platform
import shutil
from functools import lru_cache
from pathlib import Path
from typing import Literal

HostOS = Literal["macos", "linux"]
HostArch = Literal["arm64", "amd64"]


@lru_cache(maxsize=1)
def host_os() -> HostOS:
    """Return the normalized host OS string; RuntimeError if unsupported (Windows, BSDs)."""
    sys = platform.system()
    if sys == "Darwin":
        return "macos"
    if sys == "Linux":
        return "linux"
    raise RuntimeError(f"unsupported host OS: {sys} (brok-local supports macOS + Linux only)")


@lru_cache(maxsize=1)
def macos_major() -> int | None:
    """Major macOS version (e.g. 26), or None off macOS / when unparseable.

    Gates release-specific features (e.g. socket_vmnet's --vmnet-disable-dhcp, macOS 26+).
    """
    if host_os() != "macos":
        return None
    release = platform.mac_ver()[0]  # e.g. "26.5.2"
    try:
        # split() always yields >=1 element, so only int() can fail here (empty/non-numeric release).
        return int(release.split(".", 1)[0])
    except ValueError:
        return None


@lru_cache(maxsize=1)
def host_arch() -> HostArch:
    """Return the host CPU arch: arm64/aarch64 → ``arm64``; x86_64 → ``amd64``."""
    m = platform.machine().lower()
    if m in ("arm64", "aarch64"):
        return "arm64"
    return "amd64"


def domain_arch() -> str:
    """The qemu arch string used in the libvirt domain ``<type arch='...'>``."""
    return "aarch64" if host_arch() == "arm64" else "x86_64"


def _first_existing(candidates: list[Path]) -> Path | None:
    """Return the first candidate Path that exists, or None."""
    for c in candidates:
        if c.is_file():
            return c
    return None


def detect_qemu_emulator() -> Path:
    """Locate the qemu binary for the host arch, falling back to PATH."""
    arch = host_arch()
    binary = "qemu-system-aarch64" if arch == "arm64" else "qemu-system-x86_64"
    candidates = [
        Path("/opt/homebrew/bin") / binary,  # macOS Homebrew
        Path("/usr/bin") / binary,  # Linux distro
        Path("/usr/local/bin") / binary,  # Linux source build / non-Homebrew macOS
    ]
    if (found := _first_existing(candidates)) is not None:
        return found
    on_path = shutil.which(binary)
    if on_path:
        return Path(on_path)
    raise RuntimeError(
        f"qemu binary {binary!r} not found. Install qemu "
        f"({'brew install qemu' if host_os() == 'macos' else 'apt install qemu-system-x86 qemu-system-arm'})."
    )


def _qemu_firmware_candidate(name: str) -> Path | None:
    """Firmware blob under ``<prefix>/share/qemu/``, derived from the resolved qemu binary
    (Nix/Homebrew bundle the edk2 blobs there); None when qemu can't be located.
    """
    try:
        qemu = detect_qemu_emulator()
    except RuntimeError:
        return None
    return qemu.resolve().parent.parent / "share" / "qemu" / name


def detect_edk2_code() -> Path:
    """Locate the read-only UEFI firmware image for the host arch.

    Probes the blob next to the resolved qemu binary first, then distro system paths.
    """
    arch = host_arch()
    if arch == "arm64":
        candidates = [
            Path("/opt/homebrew/share/qemu/edk2-aarch64-code.fd"),  # macOS Homebrew
            Path("/usr/share/AAVMF/AAVMF_CODE.fd"),  # Debian/Ubuntu
            Path("/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw"),  # Fedora
            Path("/usr/share/edk2/aarch64/QEMU_CODE.fd"),  # Arch (edk2-aarch64)
        ]
    else:
        candidates = [
            Path("/usr/share/OVMF/OVMF_CODE_4M.fd"),  # Ubuntu 22.04+/Debian 12+ (modern 4M variant)
            Path("/usr/share/OVMF/OVMF_CODE.fd"),  # Older Debian/Ubuntu
            Path("/usr/share/edk2/x64/OVMF_CODE.fd"),  # Fedora newer
            Path("/usr/share/edk2/x64/OVMF_CODE.4m.fd"),  # Arch (edk2-ovmf)
            Path("/usr/share/edk2-ovmf/x64/OVMF_CODE.fd"),  # Fedora older
            Path("/opt/homebrew/share/qemu/edk2-x86_64-code.fd"),  # macOS (cross-build, uncommon)
        ]
    blob = "edk2-aarch64-code.fd" if arch == "arm64" else "edk2-x86_64-code.fd"
    if (derived := _qemu_firmware_candidate(blob)) is not None:
        candidates.insert(0, derived)
    if (found := _first_existing(candidates)) is not None:
        return found
    if host_os() == "macos":
        install_hint = "enter the devenv shell (direnv) — Nix provides qemu + firmware"
    elif arch == "amd64":
        install_hint = "apt install ovmf / dnf install edk2-ovmf / pacman -S edk2-ovmf"
    else:
        install_hint = "apt install qemu-efi-aarch64 / dnf install edk2-aarch64 / pacman -S edk2-aarch64"
    raise RuntimeError(
        f"UEFI firmware ({arch}) not found in any standard location. Install ovmf/aavmf ({install_hint})."
    )


def detect_edk2_vars_template() -> Path:
    """Locate the writable UEFI variables template libvirt copies per-VM at define time."""
    arch = host_arch()
    if arch == "arm64":
        candidates = [
            Path("/opt/homebrew/share/qemu/edk2-arm-vars.fd"),
            Path("/usr/share/AAVMF/AAVMF_VARS.fd"),
            Path("/usr/share/edk2/aarch64/vars-template-pflash.raw"),
            Path("/usr/share/edk2/aarch64/QEMU_VARS.fd"),  # Arch (edk2-aarch64)
        ]
    else:
        candidates = [
            Path("/usr/share/OVMF/OVMF_VARS_4M.fd"),  # Ubuntu 22.04+/Debian 12+ (modern 4M variant)
            Path("/usr/share/OVMF/OVMF_VARS.fd"),  # Older Debian/Ubuntu
            Path("/usr/share/edk2/x64/OVMF_VARS.fd"),  # Fedora newer
            Path("/usr/share/edk2/x64/OVMF_VARS.4m.fd"),  # Arch (edk2-ovmf)
            Path("/usr/share/edk2-ovmf/x64/OVMF_VARS.fd"),  # Fedora older
            Path("/opt/homebrew/share/qemu/edk2-i386-vars.fd"),  # macOS cross-build
        ]
    blob = "edk2-arm-vars.fd" if arch == "arm64" else "edk2-i386-vars.fd"
    if (derived := _qemu_firmware_candidate(blob)) is not None:
        candidates.insert(0, derived)
    if (found := _first_existing(candidates)) is not None:
        return found
    raise RuntimeError(f"UEFI vars template ({arch}) not found.")


def libvirt_socket_path() -> Path:
    """The libvirt user-session qemu socket path (``~/.cache/libvirt/virtqemud-sock``)."""
    return Path.home() / ".cache/libvirt/virtqemud-sock"


def libvirt_uri() -> str:
    """The libvirt URI to connect to.

    macOS uses an explicit user-session socket URI (avoids root-vs-user confusion when
    ipmi_sim's chassis hook runs as root); Linux uses ``qemu:///system``.
    """
    if host_os() == "macos":
        return f"qemu+unix:///session?socket={libvirt_socket_path()}"
    return "qemu:///system"
