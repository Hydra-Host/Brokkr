"""Subprocess + process wrappers used throughout local. Pure stdlib; sits at the bottom of the
import graph so daemons, prefetch, initrd, and the orchestrator share these without cycles."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections import deque
from pathlib import Path

from local.config import get_settings
from local.logger import log

# Bare command names handed to sudo() resolve against these system dirs (not the user's PATH) so
# they hit the absolute paths the sudoers allowlist pins — replacing a global secure_path drop-in.
_SUDO_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def run(*cmd, check: bool = True, capture: bool = False, **kw) -> subprocess.CompletedProcess:
    """Run a subprocess; raise ``CalledProcessError`` on failure unless ``check=False``. Tokens are
    stringified before exec; ``**kw`` is forwarded to :func:`subprocess.run`."""
    cmd_s = [str(c) for c in cmd]
    if capture:
        return subprocess.run(cmd_s, check=check, capture_output=True, text=True, **kw)
    return subprocess.run(cmd_s, check=check, **kw)


def run_streamed(*cmd, prefix: str = "", check: bool = True, tail_lines: int = 60, **kw) -> subprocess.CompletedProcess:
    """Run a subprocess, teeing merged stdout+stderr to our stdout line-by-line so a slow build is
    observable live. Flushes per line (``fleet:init`` runs without PYTHONUNBUFFERED); keeps the last
    ``tail_lines`` for the failure message."""
    cmd_s = [str(c) for c in cmd]
    tail: deque[str] = deque(maxlen=tail_lines)
    sys.stdout.flush()
    proc = subprocess.Popen(cmd_s, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, **kw)
    if proc.stdout is not None:
        for line in proc.stdout:
            sys.stdout.write(f"{prefix}{line}" if prefix else line)
            sys.stdout.flush()
            tail.append(line)
    rc = proc.wait()
    if check and rc != 0:
        raise subprocess.CalledProcessError(rc, cmd_s, output="".join(tail))
    return subprocess.CompletedProcess(cmd_s, rc, stdout="".join(tail), stderr="")


def cmd_succeeds(*cmd) -> bool:
    """Return True iff the command exits 0. Output is suppressed."""
    return run(*cmd, check=False, capture=True).returncode == 0


def iface_ipv4(iface: str) -> str | None:
    res = run("ip", "-j", "addr", "show", "dev", iface, capture=True, check=False)
    if res.returncode != 0:
        return None
    try:
        entries = json.loads(res.stdout)
    except (ValueError, TypeError):
        return None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for addr in entry.get("addr_info", []):
            if isinstance(addr, dict) and addr.get("family") == "inet" and addr.get("local"):
                return addr["local"]
    return None


def iface_is_up(iface: str) -> bool:
    res = run("ip", "-j", "addr", "show", "dev", iface, capture=True, check=False)
    if res.returncode != 0:
        return False
    try:
        entries = json.loads(res.stdout)
    except (ValueError, TypeError):
        return False
    for entry in entries:
        if isinstance(entry, dict) and (entry.get("operstate") == "UP" or "UP" in (entry.get("flags") or [])):
            return True
    return False


class DockerUnavailableError(RuntimeError):
    """Docker isn't installed, or its daemon isn't running."""


def ensure_docker_running() -> None:
    """Fail fast with an actionable message when Docker isn't usable. The grub + iPXE binaries build
    in a linux/amd64 container; without Docker running that dies as an opaque ``exit status 125``."""
    if shutil.which("docker") is None:
        raise DockerUnavailableError(
            "Docker is required to build the boot binaries but isn't installed. "
            "Install Docker (Docker Desktop on macOS, the docker engine on Linux), start it, then retry."
        )
    try:
        running = run("docker", "info", check=False, capture=True, timeout=20).returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        running = False
    if not running:
        raise DockerUnavailableError(
            "Docker is installed but the daemon isn't running (needed to build the boot binaries). "
            "Start Docker (Docker Desktop on macOS, or `sudo systemctl start docker` on Linux), "
            "wait until it's ready, then retry."
        )


def virsh(*args, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    """Run ``virsh --connect <libvirt_uri> <args>``."""
    return run("virsh", "--connect", get_settings().paths.libvirt_uri, *args, check=check, capture=capture)


def sudo(*cmd, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    """Run a command under ``sudo`` (using the cache from :func:`ensure_sudo_cached`). A bare command
    name is resolved to its absolute path under :data:`_SUDO_PATH` to match the absolute-path sudoers allowlist."""
    resolved = shutil.which(str(cmd[0]), path=_SUDO_PATH)
    if resolved:
        cmd = (resolved, *cmd[1:])
    return run("sudo", *cmd, check=check, capture=capture)


def sudo_priv(verb: str, *args, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    """Run a verb of the privileged sim helper (``brokkr-sim-priv``) under sudo — the single root
    entry point for scoped privileged ops. It validates every argument in code, so the sudoers drop-in
    needs no argument wildcards (sudo-rs-safe)."""
    return sudo(str(get_settings().paths.sim_priv_bin), verb, *args, check=check, capture=capture)


def ensure_sudo_cached() -> None:
    """Prompt once for sudo so per-op invocations don't interrupt the flow (subsequent ``sudo`` calls
    within ``timestamp_timeout`` don't prompt). Probes the helper's ``noop`` verb rather than the
    allowlisted ``/usr/bin/true``: a sibling checkout's drop-in allowlists that too, so it would
    report passwordless while this checkout's own helper path is unauthorised."""
    if not cmd_succeeds("sudo", "-n", str(get_settings().paths.sim_priv_bin), "noop"):
        log.info("requesting sudo (for socket_vmnet, ipmi_sim, lo0 aliases)")
        run("sudo", "-v")


def _read_pid(pidfile: Path) -> int | None:
    """Return the int PID in ``pidfile``, or None if absent / malformed."""
    try:
        return int(pidfile.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def _proc_alive(pid: int) -> bool:
    """Return True if a process with that PID exists. PermissionError counts as alive — the process
    exists, we just can't signal it (e.g. user-context Python checking the root-owned ipmi_sim)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
