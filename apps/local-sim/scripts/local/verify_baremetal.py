"""Bare-metal fleet verify — the non-vm half of :mod:`local.verify`, split the same way:

- :func:`collect_baremetal_live_state` — I/O only: a Redfish read per box (which separates rejected
  credentials from an unanswered BMC) plus the hub device each of the box's MACs resolves to.
- :func:`classify_baremetal` — pure: maps the applied manifest + a :class:`BareMetalLiveState`
  to findings.

Probes degrade pessimistically: a field the collector could not fill stays ``None`` and classifies
as a finding, never as health. Every cause here is off-box (cabling, credentials, a re-seed), so no
bare-metal finding is healable — ``verify --heal`` only repairs this host's daemons.

Probe modules import via function-body imports so the pure half stays cheap to import."""

from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic
from typing import TYPE_CHECKING

from local.applied import AppliedBmNode, AppliedManifest
from local.verify import DEFAULT_PROBE_BUDGET_SECONDS, FindingKind, VerifyFinding

if TYPE_CHECKING:
    from local.schema import BareMetalNode

_REDFISH_TIMEOUT = 15
_HUB_CONNECT_TIMEOUT = 5


@dataclass
class BareMetalNodeLiveState:
    """One applied box's probe results.

    ``power_state`` is ``None`` when the BMC did not answer; ``bmc_auth_ok`` is ``False`` when it
    answered and rejected the credentials, ``None`` when it was never reached. The two device ids
    are the hub devices carrying this box's PXE and BMC MAC, ``None`` when no device carries it.
    ``probe_skipped`` names why no BMC probe was attempted, so an unprobed box is not reported with
    the same remedy as a box that was probed and stayed silent. ``probed_address`` is the address the
    probe actually dialled, which is fleet.yml's and can differ from the last-applied one."""

    name: str
    power_state: str | None = None
    bmc_auth_ok: bool | None = None
    pxe_mac_device_id: str | None = None
    bmc_mac_device_id: str | None = None
    probe_skipped: str | None = None
    probed_address: str | None = None


@dataclass
class BareMetalLiveState:
    nodes: list[BareMetalNodeLiveState] = field(default_factory=list)


# ===== live collector (I/O only) =====


def _probe_bmc(node: BareMetalNode) -> tuple[str | None, bool | None, str | None]:
    """Returns ``(power_state, bmc_auth_ok, probe_skipped)`` as :class:`BareMetalNodeLiveState` defines them."""
    from local.bm_power import RedfishAuthError, probe_power_state
    from local.commission_baremetal import CommissionError, load_bmc_creds

    try:
        creds = load_bmc_creds(node.name)
    except CommissionError as exc:
        # a creds file problem is local to this host, so it must not read as a box that stayed silent
        skipped = (
            f"BMC credentials for {node.name} could not be loaded ({exc}) — save a BMC user and password on Fleet nodes"
        )
        return None, None, skipped
    try:
        return probe_power_state(node, creds, _REDFISH_TIMEOUT), True, None
    except RedfishAuthError:
        return None, False, None
    except RuntimeError:
        # bm_power's _RedfishUnusable must not escape by name; it and BmPowerError are RuntimeErrors
        return None, None, None


def _hub_identities(manifest: AppliedManifest) -> dict[str, tuple[str | None, str | None]]:
    import psycopg

    from local.config import get_settings
    from local.reconcile_baremetal import devices_carrying_mac

    settings = get_settings()
    org = settings.sim.hydrahost_org_id
    zone = settings.bridge.zone_id

    def newest(cur, mac: str) -> str | None:
        found = devices_carrying_mac(cur, org, zone, [mac])
        return found[0][0] if found else None

    out: dict[str, tuple[str | None, str | None]] = {}
    try:
        with (
            psycopg.connect(settings.stores.hub_database_url, connect_timeout=_HUB_CONNECT_TIMEOUT) as conn,
            conn.cursor() as cur,
        ):
            for bm in manifest.bm_nodes:
                out[bm.name] = (newest(cur, bm.pxe_mac), newest(cur, bm.bmc_mac))
    except psycopg.Error:
        # an unqueryable hub reads as "no device carries this box" — pessimistic, never healthy
        return {}
    return out


def collect_baremetal_live_state(
    manifest: AppliedManifest, *, probe_budget_seconds: float = DEFAULT_PROBE_BUDGET_SECONDS
) -> BareMetalLiveState:
    """Probe every applied box's BMC and hub identity. I/O only, no classification.

    Probe targets come from fleet.yml by name (never rebuilt from ``AppliedBmNode.fields``, whose
    BMC block is masked); a box the desired fleet no longer names cannot be probed at all."""
    from local.commission_baremetal import CommissionError, load_baremetal_nodes

    fleet_error: str | None = None
    try:
        fleet_nodes = {n.name: n for n in load_baremetal_nodes()}
    except CommissionError as exc:
        fleet_nodes, fleet_error = {}, f"fleet.yml could not be read ({exc})"
    identities = _hub_identities(manifest)

    nodes: list[BareMetalNodeLiveState] = []
    deadline = monotonic() + probe_budget_seconds
    for bm in manifest.bm_nodes:
        target = fleet_nodes.get(bm.name)
        if target is None:
            power_state, bmc_auth_ok, probed = None, None, None
            skipped = fleet_error or "fleet.yml no longer names this box"
        elif monotonic() >= deadline:
            power_state, bmc_auth_ok, probed = None, None, target.bmc_ip
            skipped = f"the {int(probe_budget_seconds)}s bmc probe budget ran out before this box"
        else:
            power_state, bmc_auth_ok, skipped = _probe_bmc(target)
            probed = target.bmc_ip
        pxe_device_id, bmc_device_id = identities.get(bm.name, (None, None))
        nodes.append(
            BareMetalNodeLiveState(
                name=bm.name,
                power_state=power_state,
                bmc_auth_ok=bmc_auth_ok,
                pxe_mac_device_id=pxe_device_id,
                bmc_mac_device_id=bmc_device_id,
                probe_skipped=skipped,
                probed_address=probed,
            )
        )
    return BareMetalLiveState(nodes=nodes)


# ===== pure classifier =====


def _classify_bmc(node: AppliedBmNode, ls: BareMetalNodeLiveState | None) -> list[VerifyFinding]:
    # the probe dials fleet.yml's address, which an unapplied edit can move off the manifest's
    dialled = (ls.probed_address if ls is not None and ls.probed_address else None) or node.bmc_ip
    if ls is not None and ls.probe_skipped:
        return [
            VerifyFinding(
                node=node.name,
                kind=FindingKind.BMC_UNREACHABLE,
                healable=False,
                detail=f"BMC {dialled} was not probed — {ls.probe_skipped}",
            )
        ]
    if ls is not None and ls.bmc_auth_ok is False:
        return [
            VerifyFinding(
                node=node.name,
                kind=FindingKind.BMC_AUTH_FAILED,
                healable=False,
                detail=f"BMC {dialled} rejected the stored credentials — re-seal the zone BMC creds",
            )
        ]
    if ls is None or ls.bmc_auth_ok is None or not ls.power_state:
        return [
            VerifyFinding(
                node=node.name,
                kind=FindingKind.BMC_UNREACHABLE,
                healable=False,
                detail=f"BMC {dialled} did not answer — check the box's power, cabling and BMC address",
            )
        ]
    return []


def _classify_identity(node: AppliedBmNode, ls: BareMetalNodeLiveState | None) -> list[VerifyFinding]:
    if ls is None:
        return []
    device_ids = {d for d in (ls.pxe_mac_device_id, ls.bmc_mac_device_id) if d}
    if not device_ids:
        return [
            VerifyFinding(
                node=node.name,
                kind=FindingKind.NO_HUB_DEVICE,
                healable=False,
                detail=f"no hub device carries {node.pxe_mac} or {node.bmc_mac} — re-seed the zone's devices",
            )
        ]
    # one address resolving alone still names one device; only a disagreement is a split identity
    if len(device_ids) > 1:
        return [
            VerifyFinding(
                node=node.name,
                kind=FindingKind.IDENTITY_SPLIT,
                healable=False,
                detail=(
                    f"{node.pxe_mac} and {node.bmc_mac} name different hub devices "
                    f"({', '.join(sorted(device_ids))}) — correct the fleet PXE MAC or re-seed the identity"
                ),
            )
        ]
    return []


def classify_baremetal(manifest: AppliedManifest, live: BareMetalLiveState | None) -> list[VerifyFinding]:
    """Classify the applied bare-metal boxes against a collected snapshot (pure — no I/O)."""
    by_name = {n.name: n for n in (live.nodes if live is not None else [])}
    findings: list[VerifyFinding] = []
    for bm in manifest.bm_nodes:
        ls = by_name.get(bm.name)
        findings.extend(_classify_bmc(bm, ls))
        findings.extend(_classify_identity(bm, ls))
    return findings
