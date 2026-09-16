"""Verify (and optionally heal) the applied fleet's live state against its manifest.

Three layers, split so the classifier is fixture-testable with zero I/O:
- :func:`collect_live_state` — sudo-free live probes (domstate, ipmi_sim/sushy, loopback alias,
  socket_vmnet, tagged domains, bootptab). I/O only, no classification.
- :func:`build_verify_report` — pure: maps a manifest + a :class:`LiveState` to findings.
- :func:`heal_findings` — repairs healable findings for the *applied* topology; it is not apply,
  so it refuses when the desired fleet has drifted for a finding's node (that needs a rebuild).

Bare-metal boxes classify in :mod:`local.verify_baremetal` — same collect/classify split, no heal
layer (every bare-metal cause is off-box). A plane runs when its roster (``manifest.nodes`` /
``manifest.bm_nodes``) is populated, never on ``mode``, so a manifest carrying both gets both.

Fleet primitives resolve via function-body ``from local.fleet import X`` — the apply_exec seam:
avoids the import cycle and keeps ``local.fleet`` the monkeypatch surface."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from local import applied
from local.applied import AppliedManifest
from local.apply_exec import _redefine_and_restart
from local.daemons import (
    _socket_vmnet_running,
    ipmi_sim_running,
    start_ipmi_sim,
    start_socket_vmnet,
    start_sushy_emulator,
    sushy_running,
)
from local.derived import effective_bmc_ip, effective_console_port
from local.host_os import HostOS, host_os
from local.logger import log
from local.network import (
    BOOTPTAB_PATH,
    _recover_orphaned_nics,
    add_lo_alias,
    bmc_lo_aliases,
    bootptab_section_present,
    write_bootptab,
)
from local.node_ops import _stdout_fd_to_stderr
from local.process_utils import ensure_sudo_cached, virsh
from local.schema import Fleet
from local.status import _virsh_domstate

if TYPE_CHECKING:
    from local.verify_baremetal import BareMetalLiveState

# bare-metal probing is per-box network I/O, so a fleet of dead BMCs is unbounded without a deadline; the
# lab passes its own budget and derives its exec timeout from it, this default only covers a hand-run CLI.
DEFAULT_PROBE_BUDGET_SECONDS = 120.0


class VerifyStatus(StrEnum):
    HEALTHY = "healthy"
    FINDINGS = "findings"
    NO_MANIFEST = "no-manifest"


class FindingKind(StrEnum):
    NO_MANIFEST = "no-manifest"
    DOMAIN_UNDEFINED = "domain-undefined"
    DOMAIN_NOT_RUNNING = "domain-not-running"
    IPMI_SIM_DOWN = "ipmi-sim-down"
    SUSHY_DOWN = "sushy-down"
    LO_ALIAS_MISSING = "lo-alias-missing"
    VMNET_SOCKET_MISSING = "vmnet-socket-missing"
    BOOTPTAB_MISSING = "bootptab-missing"
    ORPHAN_DOMAIN = "orphan-domain"
    BMC_UNREACHABLE = "bmc-unreachable"
    BMC_AUTH_FAILED = "bmc-auth-failed"
    NO_HUB_DEVICE = "no-hub-device"
    IDENTITY_SPLIT = "identity-split"
    # the lab composes boot readiness over HTTP; this engine emits none, but test_verify_parity pins the set
    BOOT_READINESS = "boot-readiness"


class _Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class VerifyFinding(_Wire):
    node: str | None = None
    kind: FindingKind
    healable: bool
    detail: str


class VerifySummary(_Wire):
    checked: int
    ok: int
    findings: int


class VerifyPlanes(_Wire):
    vm: bool
    baremetal: bool


class VerifyReport(_Wire):
    status: VerifyStatus
    planes: VerifyPlanes | None
    findings: list[VerifyFinding]
    summary: VerifySummary

    def model_dump_wire(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")


@dataclass
class NodeLiveState:
    name: str
    domstate: str
    ipmi_sim: bool
    sushy: bool
    lo_alias_present: bool
    vmnet_socket_present: bool | None = None  # macOS only; None off macOS


@dataclass
class LiveState:
    nodes: list[NodeLiveState] = field(default_factory=list)
    tagged_domains: list[str] = field(default_factory=list)
    bootptab_present: bool | None = None  # macOS only; None off macOS


# ===== live collector (I/O only) =====


def collect_live_state(manifest: AppliedManifest) -> LiveState:
    """Probe every applied vm node's live daemons/domain plus fleet-level orphans/bootptab.

    ONE ``bmc_lo_aliases`` read backs the per-node loopback-alias membership test (a set lookup),
    not a probe per node. All reads are sudo-free — observing a root ipmi_sim needs no privilege."""
    from local.fleet import brokkr_tagged_domains

    is_macos = host_os() == "macos"
    bmc_cidr = manifest.network.get("bmc_cidr", "")
    lo_present = set(bmc_lo_aliases(bmc_cidr)) if bmc_cidr else set()
    nodes = [
        NodeLiveState(
            name=an.name,
            domstate=_virsh_domstate(an.name),
            ipmi_sim=ipmi_sim_running(an.name),
            sushy=sushy_running(an.name),
            lo_alias_present=an.bmc_ip in lo_present,
            vmnet_socket_present=_socket_vmnet_running(an.name) if is_macos else None,
        )
        for an in manifest.nodes
    ]
    return LiveState(
        nodes=nodes,
        tagged_domains=brokkr_tagged_domains(),
        bootptab_present=bootptab_section_present() if is_macos else None,
    )


# ===== pure classifier =====


def _classify_node(name: str, bmc_ip: str, ls: NodeLiveState | None, host_os: HostOS) -> list[VerifyFinding]:
    if ls is None:
        return []
    # An undefined domain was never instantiated — apply's job, not a daemon repair; the per-node
    # daemon checks below would only pile on noise, so report the one actionable finding and stop.
    if ls.domstate == "undefined":
        return [
            VerifyFinding(
                node=name,
                kind=FindingKind.DOMAIN_UNDEFINED,
                healable=False,
                detail="libvirt domain is undefined — run `task sim:fleet:apply` to (re)build it",
            )
        ]
    out: list[VerifyFinding] = []
    if ls.domstate != "running":
        out.append(
            VerifyFinding(
                node=name,
                kind=FindingKind.DOMAIN_NOT_RUNNING,
                healable=True,
                detail=f"libvirt domain is {ls.domstate!r} — power it on",
            )
        )
    if not ls.ipmi_sim:
        out.append(
            VerifyFinding(node=name, kind=FindingKind.IPMI_SIM_DOWN, healable=True, detail="ipmi_sim (BMC) is down")
        )
    if not ls.sushy:
        out.append(
            VerifyFinding(
                node=name, kind=FindingKind.SUSHY_DOWN, healable=True, detail="sushy-emulator (Redfish) is down"
            )
        )
    if not ls.lo_alias_present:
        out.append(
            VerifyFinding(
                node=name,
                kind=FindingKind.LO_ALIAS_MISSING,
                healable=True,
                detail=f"BMC loopback alias {bmc_ip} is missing",
            )
        )
    if host_os == "macos" and ls.vmnet_socket_present is False:
        out.append(
            VerifyFinding(
                node=name,
                kind=FindingKind.VMNET_SOCKET_MISSING,
                healable=True,
                detail="socket_vmnet daemon/socket is missing",
            )
        )
    return out


def _classify_fleet(manifest: AppliedManifest, live: LiveState, host_os: HostOS) -> list[VerifyFinding]:
    out: list[VerifyFinding] = []
    manifest_names = {n.name for n in manifest.nodes}
    for dom in live.tagged_domains:
        if dom not in manifest_names:
            out.append(
                VerifyFinding(
                    node=dom,
                    kind=FindingKind.ORPHAN_DOMAIN,
                    healable=False,
                    detail="tagged libvirt domain is not in the applied manifest — adopt via apply or undefine it",
                )
            )
    if host_os == "macos" and live.bootptab_present is False:
        out.append(
            VerifyFinding(
                node=None,
                kind=FindingKind.BOOTPTAB_MISSING,
                healable=True,
                detail=f"this slot's section of {BOOTPTAB_PATH} is missing (static data-plane MAC→IP bindings)",
            )
        )
    return out


def build_verify_report(
    manifest: AppliedManifest | None,
    live: LiveState | None,
    host_os: HostOS,
    bm_live: BareMetalLiveState | None = None,
) -> VerifyReport:
    """Classify a manifest + live snapshots into a report (pure — no I/O).

    ``manifest is None`` → one non-healable ``no-manifest`` finding. Each plane is classified when
    its roster is populated — VM nodes against ``live``, bare-metal boxes against ``bm_live`` — and
    the summary sums the planes; a box with no snapshot is reported unreachable, never healthy."""
    if manifest is None:
        finding = VerifyFinding(
            node=None,
            kind=FindingKind.NO_MANIFEST,
            healable=False,
            detail="no applied manifest — bring the fleet up with `task up` before verifying",
        )
        return VerifyReport(
            status=VerifyStatus.NO_MANIFEST,
            planes=None,
            findings=[finding],
            summary=VerifySummary(checked=0, ok=0, findings=1),
        )
    findings: list[VerifyFinding] = []
    checked = 0
    ok = 0
    if manifest.nodes:
        live = live or LiveState()
        live_by_name = {n.name: n for n in live.nodes}
        for an in manifest.nodes:
            node_findings = _classify_node(an.name, an.bmc_ip, live_by_name.get(an.name), host_os)
            if node_findings:
                findings.extend(node_findings)
            else:
                ok += 1
        findings.extend(_classify_fleet(manifest, live, host_os))
        checked += len(manifest.nodes)
    if manifest.bm_nodes:
        from local.verify_baremetal import classify_baremetal

        bm_findings = classify_baremetal(manifest, bm_live)
        findings.extend(bm_findings)
        checked += len(manifest.bm_nodes)
        ok += len(manifest.bm_nodes) - len({f.node for f in bm_findings})

    status = VerifyStatus.HEALTHY if not findings else VerifyStatus.FINDINGS
    vm, bm = applied.planes_of(manifest.nodes, manifest.bm_nodes)
    return VerifyReport(
        status=status,
        planes=VerifyPlanes(vm=vm, baremetal=bm),
        findings=findings,
        summary=VerifySummary(checked=checked, ok=ok, findings=len(findings)),
    )


# ===== heal executor =====


def _drifted_node_names(diff: applied.FleetDiff) -> set[str]:
    return (
        {n.name for n in diff.nodes.changed} | {n.name for n in diff.nodes.added} | {n.name for n in diff.nodes.removed}
    )


def heal_findings(fleet: Fleet, applied_manifest: AppliedManifest, report: VerifyReport, host_os: HostOS) -> None:
    """Repair every healable finding for the *applied* topology, in a dependency-safe order.

    Ordering constraints: refuse before any privileged op if the desired fleet has drifted for a
    finding's node (heal is not apply — a rebuild is needed, `task sim:fleet:apply`); then bootptab
    and socket_vmnet (macOS, fleet-wide) before per-node repairs; and per node the loopback alias
    before ipmi_sim (which binds it). Node objects come from :meth:`Fleet.nodes` by name, never
    reconstructed from ``AppliedNode.fields`` (an override would desync the binds)."""
    healable = [f for f in report.findings if f.healable]
    if not healable:
        return

    diff = applied.diff(fleet, applied_manifest, host_os)
    drifted = _drifted_node_names(diff)
    blocked = sorted({f.node for f in healable if f.node and f.node in drifted})
    if blocked:
        raise SystemExit(
            f"refusing to heal {blocked}: the applied topology has drifted for these node(s) — "
            "run `task sim:fleet:apply` first (verify --heal repairs daemons, it is not apply)"
        )
    # bootptab/socket_vmnet consume the whole desired fleet, so ANY drift (incl. network-only,
    # which _drifted_node_names can't see) would encode un-applied topology into the data plane
    fleet_wide = sorted(
        f.kind.value for f in healable if f.kind in (FindingKind.BOOTPTAB_MISSING, FindingKind.VMNET_SOCKET_MISSING)
    )
    if fleet_wide and not diff.in_sync:
        raise SystemExit(
            f"refusing fleet-wide heal(s) {fleet_wide}: fleet.yml has drifted from the applied topology — "
            "run `task sim:fleet:apply` first (verify --heal repairs daemons, it is not apply)"
        )

    ensure_sudo_cached()
    idx_by_name = {n.name: i for i, n in enumerate(fleet.nodes)}
    node_by_name = {n.name: n for n in fleet.nodes}
    kinds = {f.kind for f in healable}

    if host_os == "macos" and FindingKind.BOOTPTAB_MISSING in kinds:
        write_bootptab(fleet)
    if host_os == "macos" and FindingKind.VMNET_SOCKET_MISSING in kinds:
        # DHCP mode needs the spoke's raw /dev/bpf sockets, revoked on `fleet down`; grant before the
        # restart, mirroring VmOps.up — a socket-only restart would report healthy while DHCP stays broken
        if fleet.network.dhcp:
            from local.fleet import grant_bpf

            grant_bpf()
        restarted = start_socket_vmnet(fleet)
        for name in _recover_orphaned_nics(restarted):
            idx = idx_by_name.get(name)
            if idx is not None:
                _redefine_and_restart(fleet, fleet.nodes[idx], idx)

    node_kinds: dict[str, set[FindingKind]] = {}
    for f in healable:
        if f.node is not None:
            node_kinds.setdefault(f.node, set()).add(f.kind)
    for name, node_finding_kinds in node_kinds.items():
        node = node_by_name.get(name)
        idx = idx_by_name.get(name)
        if node is None or idx is None:
            continue
        bmc = effective_bmc_ip(node, fleet.network.bmc_cidr, idx)
        if FindingKind.LO_ALIAS_MISSING in node_finding_kinds:
            add_lo_alias(bmc)
        if FindingKind.IPMI_SIM_DOWN in node_finding_kinds:
            start_ipmi_sim(node, bmc, effective_console_port(node, idx))
        if FindingKind.SUSHY_DOWN in node_finding_kinds:
            start_sushy_emulator(node, bmc)
        if FindingKind.DOMAIN_NOT_RUNNING in node_finding_kinds:
            # re-probe at heal time — the domain may have self-recovered in the classify→heal window
            # (concurrent start, qemu auto-resume from an I/O pause); both `start` and `resume` error on a
            # running domain, so no-op it. paused/pmsuspended needs resume; anything else needs start.
            state = _virsh_domstate(node.name)
            if state in ("paused", "pmsuspended"):
                virsh("resume", node.name, capture=True)
            elif state != "running":
                virsh("start", node.name, capture=True)


# ===== orchestration (CLI-facing) =====


def _emit_human(report: VerifyReport) -> None:
    if report.status == VerifyStatus.HEALTHY:
        log.success(f"fleet verify: healthy — {report.summary.checked} node(s) checked, no findings")
        return
    for f in report.findings:
        target = f.node or "fleet"
        suffix = "" if f.healable else " (needs apply — not auto-healable)"
        log.warn(f"{target}: {f.kind.value} — {f.detail}{suffix}")


def run_verify(
    fleet: Fleet | None,
    manifest: AppliedManifest | None,
    *,
    heal: bool = False,
    as_json: bool = False,
    probe_budget_seconds: float = DEFAULT_PROBE_BUDGET_SECONDS,
) -> int:
    """Verify (and optionally heal) the applied fleet; 0 healthy / 2 findings remain.

    ``--json`` keeps stdout a pure ``VerifyReport`` envelope: the logger routes to stderr and fd 1
    is pointed at stderr while the collect/heal probes shell out (pgrep/virsh)."""
    if as_json:
        log.use_stderr_only()
    with _stdout_fd_to_stderr(as_json):
        if manifest is None:
            report = build_verify_report(manifest, None, host_os())
        else:
            from local.verify_baremetal import collect_baremetal_live_state

            vm_live = collect_live_state(manifest) if manifest.nodes else None
            bm_live = (
                collect_baremetal_live_state(manifest, probe_budget_seconds=probe_budget_seconds)
                if manifest.bm_nodes
                else None
            )
            report = build_verify_report(manifest, vm_live, host_os(), bm_live)
            if heal and any(f.healable for f in report.findings):
                if fleet is None:
                    raise SystemExit("cannot heal: no fleet.yml found — run `task up` (or fleet:init) first")
                heal_findings(fleet, manifest, report, host_os())
                # heal only repairs this host's VM daemons, so only the VM snapshot is retaken
                report = build_verify_report(manifest, collect_live_state(manifest), host_os(), bm_live)
    if as_json:
        print(report.model_dump_json(by_alias=True), flush=True)
    else:
        _emit_human(report)
    return 0 if report.status == VerifyStatus.HEALTHY else 2
