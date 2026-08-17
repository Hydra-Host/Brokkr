"""Daemon lifecycle: socket_vmnet, ipmi_sim, sushy-emulator. Each exposes ``X_running()`` /
``start_X(...)`` / ``stop_X(...)`` (shared Popen-+-wait-for-up, independent state). virtqemud is no
longer started here; :func:`libvirt_uri_for_root` stays (ipmi_sim/sushy need the session socket URI)."""

from __future__ import annotations

import ipaddress
import os
import re
import shutil
import signal
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

from local.config import get_settings
from local.derived import node_uuid
from local.host_os import macos_major
from local.logger import log
from local.process_utils import _proc_alive, _read_pid, cmd_succeeds, run, sudo_priv
from local.schema import Fleet, Node


def libvirt_uri_for_root() -> str:
    """Build a libvirt URI usable from a root-spawned process (ipmi_sim's chassis hook): on macOS
    the explicit socket path forces the user-session virtqemud (``qemu:///session`` under sudo
    resolves to root's); Linux uses the system ``qemu:///system``."""
    from local.host_os import host_os

    if host_os() == "linux":
        return "qemu:///system"
    sock = Path.home() / ".cache/libvirt/virtqemud-sock"
    if not sock.exists():
        raise RuntimeError(
            f"User libvirt session socket not found at {sock}. Is libvirtd running? `sudo brew services start libvirt`"
        )
    return f"qemu+unix:///session?socket={sock}"


# ===== socket_vmnet =====

# One daemon per VM: Apple's vmnet.framework serializes packet I/O per handle, so a noisy VM
# starves quiet ones on a shared handle. Same gateway + DHCP range keeps guests on one NAT subnet.


def _socket_vmnet_running(node: str) -> bool:
    pid = _read_pid(get_settings().state.socket_vmnet_pid_for(node))
    return pid is not None and _proc_alive(pid)


def _spawn_socket_vmnet(node: str, gateway: str, dhcp_end: str) -> None:
    """Classic per-node create (non-DHCP mode / pre-macOS-26): each daemon creates its own
    shared-mode vmnet handle. DHCP mode uses the owner/join model instead (_start_shared_network)."""
    s = get_settings()
    sock = s.state.socket_vmnet_sock_for(node)
    pid = s.state.socket_vmnet_pid_for(node)
    log_path = s.state.socket_vmnet_log_for(node)

    log.info(f"start socket_vmnet[{node}] → {sock}")
    sock.parent.mkdir(parents=True, exist_ok=True)
    pid.unlink(missing_ok=True)
    if sock.exists():
        sudo_priv("vmnet-sock-rm", str(sock))
    argv = [
        "sudo",
        str(s.paths.socket_vmnet_bin),
        "--vmnet-mode=shared",
        f"--vmnet-gateway={gateway}",
        f"--vmnet-dhcp-end={dhcp_end}",
        "--pidfile",
        str(pid),
        "--socket-group=staff",
        str(sock),
    ]
    with open(log_path, "ab") as log_fd:
        subprocess.Popen(
            argv,
            stdout=log_fd,
            stderr=log_fd,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )


def _shared_blob_path() -> Path:
    """Path of the shared-network serialization blob the owner writes and joiners read."""
    return get_settings().state.run_dir / "socket_vmnet-shared.blob"


def _spawn_owner(gateway: str, dhcp_end: str) -> None:
    """Spawn owner: creates & serializes disable-dhcp network.
    Tracked as 'owner' pseudo-node for unified teardown."""
    s = get_settings()
    blob = _shared_blob_path()
    pid = s.state.socket_vmnet_pid_for("owner")
    log_path = s.state.socket_vmnet_log_for("owner")
    log.info(f"start socket_vmnet owner (creates shared disable-dhcp network → {blob.name})")
    blob.parent.mkdir(parents=True, exist_ok=True)
    pid.unlink(missing_ok=True)
    blob.unlink(missing_ok=True)  # a stale blob names a network that no longer exists
    # --vmnet-mode=shared stays first so the socket_vmnet sudoers rule (`<bin> --vmnet-mode=shared *`)
    # matches; the owner takes no positional socket path.
    argv = [
        "sudo",
        str(s.paths.socket_vmnet_bin),
        "--vmnet-mode=shared",
        "--vmnet-disable-dhcp",
        f"--vmnet-gateway={gateway}",
        f"--vmnet-dhcp-end={dhcp_end}",
        f"--vmnet-serialize-to={blob}",
        "--pidfile",
        str(pid),
    ]
    with open(log_path, "ab") as log_fd:
        subprocess.Popen(argv, stdout=log_fd, stderr=log_fd, stdin=subprocess.DEVNULL, start_new_session=True)


def _spawn_joiner(node: str) -> None:
    """Spawn a JOINER: attaches its own interface to the owner's shared network (own dispatch queue
    → no head-of-line starvation) and serves this node's qemu socket."""
    s = get_settings()
    blob = _shared_blob_path()
    sock = s.state.socket_vmnet_sock_for(node)
    pid = s.state.socket_vmnet_pid_for(node)
    log_path = s.state.socket_vmnet_log_for(node)
    log.info(f"start socket_vmnet joiner[{node}] → {sock} (shared network)")
    sock.parent.mkdir(parents=True, exist_ok=True)
    pid.unlink(missing_ok=True)
    if sock.exists():
        sudo_priv("vmnet-sock-rm", str(sock))
    argv = [
        "sudo",
        str(s.paths.socket_vmnet_bin),
        "--vmnet-mode=shared",
        f"--vmnet-join-from={blob}",
        "--pidfile",
        str(pid),
        "--socket-group=staff",
        str(sock),
    ]
    with open(log_path, "ab") as log_fd:
        subprocess.Popen(argv, stdout=log_fd, stderr=log_fd, stdin=subprocess.DEVNULL, start_new_session=True)


def _wait_for_socks(
    pending: dict[str, Path],
    owner_check: Callable[[], bool] | None = None,
) -> None:
    """Block until every pending node's socket exists (15s deadline); if owner_check returns
    False, raise immediately (owner died)."""
    deadline = time.monotonic() + 15.0
    while pending and time.monotonic() < deadline:
        # Prune resolved sockets first, THEN diagnose a dead owner — so a node whose socket already
        # materialised is never falsely reported as "owner died" when the owner dies in the same tick.
        for name, sock_path in list(pending.items()):
            if sock_path.exists():
                del pending[name]
        if pending and owner_check is not None and not owner_check():
            raise RuntimeError(
                f"socket_vmnet owner died while waiting for joiner sockets: {sorted(pending)} "
                "(check the owner log for the root cause)"
            )
        if pending:
            time.sleep(0.25)
    if pending:
        raise RuntimeError(f"socket_vmnet did not create sockets within 15s: {sorted(pending)}")


def _start_shared_network(fleet: Fleet, gateway: str, dhcp_end: str) -> list[str]:
    """DHCP mode: owner creates the shared disable-dhcp network, nodes join with their own
    interface (macOS-26 single-owner API; per-node isolation via separate joiners)."""
    s = get_settings()
    blob = _shared_blob_path()
    if not _socket_vmnet_running("owner"):
        _spawn_owner(gateway, dhcp_end)
    # The owner must publish the blob before any joiner can attach.
    deadline = time.monotonic() + 15.0
    while not blob.exists() and time.monotonic() < deadline:
        if not _socket_vmnet_running("owner"):
            raise RuntimeError("socket_vmnet owner exited before writing the shared-network blob (see its log)")
        time.sleep(0.25)
    if not blob.exists():
        raise RuntimeError("socket_vmnet owner did not write the shared-network blob within 15s")
    # Blob can exist while owner crashed. Re-verify liveness to prevent joiners hanging on dead owner.
    if not _socket_vmnet_running("owner"):
        raise RuntimeError("socket_vmnet owner exited immediately after writing the shared-network blob (see its log)")

    pending: dict[str, Path] = {}
    for node in fleet.nodes:
        if _socket_vmnet_running(node.name):
            continue
        _spawn_joiner(node.name)
        pending[node.name] = s.state.socket_vmnet_sock_for(node.name)
    started = list(pending)
    _wait_for_socks(pending, owner_check=lambda: _socket_vmnet_running("owner"))
    # Pin vmnet host gateway to .1 (not .0); derive netmask from fleet CIDR for non-/24 support.
    # Do after interfaces exist, before VM boot.
    netmask = str(ipaddress.ip_network(fleet.network.cidr, strict=False).netmask)
    log.info(f"pin vmnet host interface to gateway {gateway}/{netmask}")
    sudo_priv("vmnet-hostip", gateway, netmask)
    return started


def start_socket_vmnet(fleet: Fleet) -> list[str]:
    """Spawn one socket_vmnet daemon per node and pin the subnet to fleet.yml (without the gateway
    flags vmnet picks its own subnet). Returns the names of nodes (re)started this call, so ``cmd_up``
    can power-cycle any node whose qemu still runs against a now-replaced socket."""
    s = get_settings()
    net = ipaddress.ip_network(fleet.network.cidr, strict=False)
    gateway = str(net.network_address + 1)
    dhcp_end = str(net.network_address + 254)

    # DHCP mode: owner creates shared network (silences bootpd); nodes join with own interface.
    # Requires macOS 26+ (single-owner API); pre-26 falls back to classic mode (warn: bootpd races).
    if fleet.network.dhcp:
        major = macos_major()
        if (major or 0) >= 26:
            return _start_shared_network(fleet, gateway, dhcp_end)
        detected = f"macOS {major}" if major is not None else "not macOS"
        log.warn(
            f"network.dhcp is set but the disable-dhcp vmnet API needs macOS 26+ (detected: {detected}); "
            "using classic per-node vmnet — Apple bootpd will race the bridge's DHCP."
        )

    pending: dict[str, Path] = {}
    for node in fleet.nodes:
        if _socket_vmnet_running(node.name):
            continue
        _spawn_socket_vmnet(node.name, gateway, dhcp_end)
        pending[node.name] = s.state.socket_vmnet_sock_for(node.name)
    started = list(pending)
    _wait_for_socks(pending)
    return started


def _stop_one_socket_vmnet(node: str) -> None:
    s = get_settings()
    pid_path = s.state.socket_vmnet_pid_for(node)
    pid = _read_pid(pid_path)
    if pid is None:
        return
    log.info(f"stop socket_vmnet[{node}] (pid {pid})")
    # helper reads the pid from the pidfile, verifies the process is actually socket_vmnet
    # before killing, then removes the socket — both paths validated under the user's home.
    sudo_priv("vmnet-stop", str(pid_path), str(s.state.socket_vmnet_sock_for(node)), check=False)
    pid_path.unlink(missing_ok=True)


def stop_socket_vmnet() -> None:
    """Stop every per-node socket_vmnet daemon. Globs live ``socket_vmnet.*.pid`` rather than
    reading ``fleet.yml`` so daemons for removed/renamed nodes aren't silently orphaned."""
    s = get_settings()
    for pid_file in s.state.run_dir.glob("socket_vmnet.*.pid"):
        node = pid_file.name[len("socket_vmnet.") : -len(".pid")]
        _stop_one_socket_vmnet(node)


# ===== ipmi_sim (the BMC plane) =====


_CHASSISCTL = Path(__file__).resolve().parent.parent / "ipmi-sim-chassisctl.py"


def _virsh_bin() -> str:
    return shutil.which("virsh") or "virsh"


def _ipmi_sim_dir(node_name: str) -> Path:
    return get_settings().state.ipmi_sim_dir_for(node_name)


def ipmi_sim_running(node_name: str) -> bool:
    """True if this node's ipmi_sim is running (matched by its per-node lan.conf path)."""
    return cmd_succeeds("pgrep", "-f", str(_ipmi_sim_dir(node_name) / "lan.conf"))


def start_ipmi_sim(node: Node, bmc: str, console_port: int | None = None) -> None:
    """Start an ipmi_sim instance for one node, bound to its BMC alias IP:623. Launched as root via
    ``brokkr-sim-priv ipmi-launch`` (validates the config dir is under $HOME and builds ``-c/-f/-s``
    itself, so a caller can't redirect ``-c``); its ``chassis_control`` hook actuates the VM via
    ``virsh``. ``console_port`` backs SOL onto the VM's qemu console (omit to disable)."""
    s = get_settings()
    binp = s.paths.ipmi_sim
    if not binp.is_file():
        raise RuntimeError(f"ipmi_sim not found: {binp} (set LOCAL_IPMI_SIM_BIN / build devenv/pkgs/openipmi.nix)")

    _CHASSISCTL.chmod(_CHASSISCTL.stat().st_mode | 0o111)

    cfg = _ipmi_sim_dir(node.name)
    state_dir = cfg / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    guid = node_uuid(node.ipmi_mac).replace("-", "")
    sol_line = f'  sol "telnet:127.0.0.1:{console_port}" 115200\n' if console_port else ""
    (cfg / "lan.conf").write_text(
        f'name "{node.name}"\n'
        "set_working_mc 0x20\n"
        "  startlan 1\n"
        f"    addr {bmc} 623\n"
        "    priv_limit admin\n"
        "    allowed_auths_callback none md2 md5 straight\n"
        "    allowed_auths_user      none md2 md5 straight\n"
        "    allowed_auths_operator  none md2 md5 straight\n"
        "    allowed_auths_admin     none md2 md5 straight\n"
        f"    guid {guid}\n"
        "  endlan\n"
        f'  chassis_control "{_CHASSISCTL} {_virsh_bin()} {node.name} {libvirt_uri_for_root()} {state_dir}"\n'
        f"{sol_line}"
        "  startnow false\n"
        f'  user 1 true  ""               "{node.bmc.password}" user  10 none md2 md5 straight\n'
        f'  user 2 true  "{node.bmc.username}" "{node.bmc.password}" admin 10 none md2 md5 straight\n'
    )
    (cfg / "sim.emu").write_text(
        "mc_setbmc 0x20\n"
        "mc_add 0x20 0 no-device-sdrs 0x23 9 8 0x9f 0x1291 0xf02\n"
        "sel_enable 0x20 1000 0x0a\n"
        "mc_enable 0x20\n"
    )

    if ipmi_sim_running(node.name):
        log.info(f"ipmi_sim already running for {node.name}; restart")
        stop_ipmi_sim(node.name)
    log.info(f"start ipmi_sim {node.name} on BMC plane {bmc}:623 (root, lanserv, via sim-priv helper)")
    with open(cfg / "ipmi_sim.log", "ab") as log_fd:
        # the helper execs `ipmi_sim -c cfg/lan.conf -f cfg/sim.emu -s cfg/state -n`; the resulting
        # cmdline still carries the lan.conf path the liveness check tracks.
        subprocess.Popen(
            ["sudo", str(s.paths.sim_priv_bin), "ipmi-launch", str(cfg)],
            stdout=log_fd,
            stderr=log_fd,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    for _ in range(20):
        if ipmi_sim_running(node.name):
            return
        time.sleep(0.5)
    raise RuntimeError(f"ipmi_sim for {node.name} did not start within 10s")


def stop_ipmi_sim(node_name: str, best_effort: bool = False) -> None:
    """Stop a node's ipmi_sim, matched by its per-node lan.conf cmdline (sudo, root-owned)."""
    pattern = str(_ipmi_sim_dir(node_name) / "lan.conf")
    if not ipmi_sim_running(node_name):
        return
    log.info(f"stop ipmi_sim for {node_name}")
    sudo_priv("ipmi-stop", pattern, check=False)
    for i in range(20):
        if not ipmi_sim_running(node_name):
            return
        if i == 10:
            sudo_priv("ipmi-kill", pattern, check=False)
        time.sleep(0.5)
    msg = f"ipmi_sim for {node_name} did not stop within 10s"
    if best_effort:
        log.warn(msg)
        return
    raise RuntimeError(msg)


def ipmi_sim_registered_names() -> list[str]:
    """Every node with an on-disk ipmi_sim config dir (incl. orphans from removed nodes). Read from
    the user-side state tree so teardown works even with the daemons already stopped."""
    root = get_settings().state.root / "state/ipmi-sim"
    if not root.is_dir():
        return []
    return [p.name for p in root.iterdir() if p.is_dir()]


def purge_ipmi_sim(node_name: str) -> None:
    """Stop a node's ipmi_sim and remove its config/state dir (teardown). The state
    dir holds files ipmi_sim wrote as root, so remove it via sudo."""
    stop_ipmi_sim(node_name, best_effort=True)
    sudo_priv("ipmi-purge", str(_ipmi_sim_dir(node_name)), check=False)


# ===== sushy-emulator =====


def sushy_pidfile(node_name: str) -> Path:
    return get_settings().state.run_dir / f"sushy.{node_name}.pid"


def sushy_conf_path(node_name: str) -> Path:
    return get_settings().state.sushy_conf_dir / f"{node_name}.conf.py"


def sushy_running(node_name: str) -> bool:
    pid = _read_pid(sushy_pidfile(node_name))
    return pid is not None and _proc_alive(pid)


def _sushy_pids(node_name: str) -> set[int]:
    """PIDs of sushy-emulator processes running this node's config, matched by cmdline via pgrep.
    The path is regex-escaped since pgrep -f patterns are regexes (bare dots would wildcard)."""
    res = run("pgrep", "-f", re.escape(str(sushy_conf_path(node_name))), check=False, capture=True)
    return {int(tok) for tok in res.stdout.split() if tok.isdigit()}


def start_sushy_emulator(node: Node, bmc: str, htpasswd: Path | None = None) -> None:
    """Start a sushy-emulator instance bound to one node's BMC IP (``node.ipmi_mac`` seeds the
    Redfish system UUID; ``htpasswd`` None means no auth)."""
    s = get_settings()
    uuid = node_uuid(node.ipmi_mac)
    conf = sushy_conf_path(node.name)
    conf.write_text(
        f"SUSHY_EMULATOR_LISTEN_IP = '{bmc}'\n"
        f"SUSHY_EMULATOR_LISTEN_PORT = {s.sim.redfish_port}\n"
        f"SUSHY_EMULATOR_LIBVIRT_URI = '{s.paths.libvirt_uri}'\n"
        + (f"SUSHY_EMULATOR_AUTH_FILE = '{htpasswd}'\n" if htpasswd else "SUSHY_EMULATOR_AUTH_FILE = None\n")
        + f"SUSHY_EMULATOR_ALLOWED_INSTANCES = ['{uuid}']\n"
    )

    pidf = sushy_pidfile(node.name)
    if sushy_running(node.name):
        log.info(f"sushy already running for {node.name}; restart")
        stop_sushy_emulator(node.name)

    log_path = s.state.sushy_log_dir / f"{node.name}.log"
    with open(log_path, "ab") as log_fd:
        p = subprocess.Popen(
            [str(s.paths.sushy), "--config", str(conf)],
            stdout=log_fd,
            stderr=log_fd,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    pidf.write_text(str(p.pid))


def stop_sushy_emulator(node_name: str) -> None:
    """Stop a node's sushy-emulator, verifying identity before signalling (the pidfile PID could be
    reused once sushy exits). The bounded exit wait (SIGKILL at the midpoint) lets a follow-on start
    rebind the port without racing."""
    pidf = sushy_pidfile(node_name)
    pid = _read_pid(pidf)
    if pid is None:
        return
    if pid not in _sushy_pids(node_name):
        pidf.unlink(missing_ok=True)
        return
    log.info(f"stop sushy for {node_name} (pid {pid})")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for i in range(20):
        if pid not in _sushy_pids(node_name):
            break
        if i == 10:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.5)
    else:
        log.warn(f"sushy for {node_name} did not exit within 10s")
    pidf.unlink(missing_ok=True)
