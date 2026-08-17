"""Single-node lifecycle verbs behind ``python -m local.fleet node <up|down|restart|undefine>``.
Fleet primitives resolve via function-body ``from local.fleet import X`` — the apply_exec
pattern: avoids the import cycle and keeps ``local.fleet`` the monkeypatch surface."""

from __future__ import annotations

import contextlib
import os
import sys

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from local.apply_exec import _redefine_and_restart, _teardown_one_node
from local.daemons import (
    ipmi_sim_running,
    purge_ipmi_sim,
    start_socket_vmnet,
    stop_sushy_emulator,
    sushy_running,
)
from local.derived import effective_bmc_ip
from local.host_os import host_os
from local.logger import log
from local.network import (
    _recover_orphaned_nics,
    ensure_data_plane_bridge,
    remove_lo_alias,
    write_bootptab,
)
from local.process_utils import ensure_sudo_cached, virsh
from local.schema import Fleet, Node
from local.status import _virsh_domstate


class NodeOpResult(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    verb: str
    ok: bool
    domain: str
    ipmi_sim: bool
    sushy: bool
    error: str | None = None


def _error_detail(e: Exception) -> str:
    stderr = getattr(e, "stderr", None)
    if isinstance(stderr, str) and stderr.strip():
        return f"{e}\n{stderr.strip()}"
    return str(e)


@contextlib.contextmanager
def _stdout_fd_to_stderr(enabled: bool):
    """Point fd 1 at stderr for the duration: verbs shell through uncaptured child processes
    (qemu-img, pgrep) whose inherited-stdout output would corrupt the JSON envelope."""
    if not enabled:
        yield
        return
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


def _destroy_if_running(name: str) -> None:
    if virsh("domstate", name, check=False, capture=True).stdout.strip() == "running":
        log.info(f"power off domain {name}")
        virsh("destroy", name, check=False, capture=True)


def _up_one_node(fleet: Fleet, node: Node, idx: int) -> None:
    """Single-node slice of ``VmOps.up``: the same preamble (state dirs, render, platform net
    plumbing incl. bootptab/BPF on macOS, orphan-NIC recovery, console-log permissions), then
    wire just this node into libvirt + ipmi_sim + sushy."""
    from local.fleet import (
        _make_console_logs_readable,
        _prepare_console_logs,
        _setup_one_node,
        ensure_state_dirs,
        grant_bpf,
        render_xmls,
    )

    ensure_state_dirs()
    render_xmls()
    restarted: list[str] = []
    if host_os() == "macos":
        write_bootptab(fleet)
        if fleet.network.dhcp:
            grant_bpf()
        restarted = start_socket_vmnet(fleet)
    else:
        ensure_data_plane_bridge(fleet)
    for name in _recover_orphaned_nics(restarted):
        if name == node.name:
            continue  # the target is restarted by _setup_one_node below
        other = next((i for i, n in enumerate(fleet.nodes) if n.name == name), None)
        if other is not None:
            _redefine_and_restart(fleet, fleet.nodes[other], other)
    _prepare_console_logs(fleet)
    _setup_one_node(fleet, node, idx)
    _make_console_logs_readable(fleet)


def _down_one_node(fleet: Fleet, node: Node, idx: int) -> None:
    """Single-node slice of ``fleet._vm_down`` (which keeps its own all-VMs-first ordering):
    destroy → stop sushy → purge ipmi_sim → drop the BMC loopback alias. Domain stays defined."""
    _destroy_if_running(node.name)
    stop_sushy_emulator(node.name)
    purge_ipmi_sim(node.name)
    remove_lo_alias(effective_bmc_ip(node, fleet.network.bmc_cidr, idx))


def _restart_one_node(fleet: Fleet, node: Node, idx: int) -> None:
    from local.fleet import _make_console_logs_readable, _prepare_console_logs, _setup_one_node

    _destroy_if_running(node.name)
    _prepare_console_logs(fleet)
    _setup_one_node(fleet, node, idx)
    _make_console_logs_readable(fleet)


def _undefine_one_node(fleet: Fleet, node: Node, idx: int, purge: bool) -> None:
    """Runtime-only teardown: the applied manifest still records the node (diff stays in-sync
    and apply won't restore it) — bring it back with ``node up``."""
    _teardown_one_node(node.name, effective_bmc_ip(node, fleet.network.bmc_cidr, idx), purge_disks=purge)


def run_node_verb(fleet: Fleet, idx: int, verb: str, *, as_json: bool = False, purge: bool = False) -> int:
    """Run one node verb, then report the node's post-state (0 ok / 1 failed).

    ``--json`` keeps stdout a pure ``NodeOpResult`` envelope: the logger routes to stderr and
    fd 1 is pointed at stderr while the verb + post-state probes run.
    """
    if as_json:
        log.use_stderr_only()
    node = fleet.nodes[idx]
    error: str | None = None
    with _stdout_fd_to_stderr(as_json):
        try:
            ensure_sudo_cached()
            if verb == "up":
                _up_one_node(fleet, node, idx)
            elif verb == "down":
                _down_one_node(fleet, node, idx)
            elif verb == "restart":
                _restart_one_node(fleet, node, idx)
            elif verb == "undefine":
                _undefine_one_node(fleet, node, idx, purge)
            else:
                raise SystemExit(f"unknown node verb {verb!r}")
        except Exception as e:
            error = _error_detail(e)
        result = NodeOpResult(
            name=node.name,
            verb=verb,
            ok=error is None,
            domain=_virsh_domstate(node.name),
            ipmi_sim=ipmi_sim_running(node.name),
            sushy=sushy_running(node.name),
            error=error,
        )
    if as_json:
        print(result.model_dump_json(by_alias=True), flush=True)
    elif result.ok:
        log.info(f"node {verb} {node.name}: domain={result.domain!r} ipmi_sim={result.ipmi_sim} sushy={result.sushy}")
    else:
        log.error(f"node {verb} {node.name} failed: {error}")
    return 0 if result.ok else 1
