"""Applied-fleet manifest + drift diff: the engine records what it instantiated so drift is
computed without re-deriving. Envelopes camelCase on the wire; ``AppliedNode.fields`` keeps
snake_case verbatim (the contract field names + the apply classifier match those literally)."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from local.config import get_settings
from local.derived import effective_bmc_ip, effective_node_ip
from local.host_os import HostOS
from local.logger import log
from local.schema import BareMetalNodeResolved, Fleet, Node

SCHEMA_VERSION = 1
APPLY_HINT_CLI = "run `task sim:fleet:apply`"

Severity = Literal["in-sync", "hot-appliable", "needs-full-rebuild", "mode-change"]

# canonical field classifications — single source of truth; apply_plan imports these.
IDENTITY_FIELDS = ("ipmi_mac", "data_mac", "arch", "zone", "ip", "bmc_ip", "index")
DISK_FIELDS = ("disk_gb", "disks")
HOT_FIELDS = ("cpus", "memory_mb", "nics", "data_mtu", "passthrough")


class _Envelope(BaseModel):
    """Base for every wire model: camelCase aliases out, accept either name in."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AppliedNode(_Envelope):
    name: str
    zone: str = ""
    index: int
    ip: str
    bmc_ip: str
    fields: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def resolve(cls, node: Node, index: int, cidr: str, bmc_cidr: str) -> Self:
        payload = node.model_dump(mode="json")
        payload["index"] = index
        payload["ip"] = effective_node_ip(node, cidr, index)
        payload["bmc_ip"] = effective_bmc_ip(node, bmc_cidr, index)
        return cls(
            name=node.name, zone=node.zone, index=index, ip=payload["ip"], bmc_ip=payload["bmc_ip"], fields=payload
        )

    @classmethod
    def from_record(cls, rec: dict[str, Any]) -> Self:
        return cls(
            name=rec["name"],
            zone=rec.get("zone", ""),
            index=int(rec["index"]),
            ip=rec["ip"],
            bmc_ip=rec["bmc_ip"],
            fields=rec,
        )

    def model_dump_node(self) -> dict[str, Any]:
        """On-wire node = the snake payload itself (round-trips via from_record)."""
        return self.fields


class AppliedBmNode(_Envelope):
    name: str
    zone: str = ""
    pxe_mac: str
    bmc_ip: str
    bmc_mac: str
    arch: str
    system_id: str | None = None
    fields: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def resolve(cls, node: BareMetalNodeResolved) -> Self:
        payload = node.model_dump(mode="json")
        if "bmc" in payload:
            payload["bmc"] = _mask_bmc(payload)
        return cls(
            name=node.name,
            zone=node.zone,
            pxe_mac=node.pxe_mac,
            bmc_ip=node.bmc_ip,
            bmc_mac=node.bmc_mac,
            arch=node.arch,
            system_id=node.system_id,
            fields=payload,
        )

    @classmethod
    def from_record(cls, rec: dict[str, Any]) -> Self:
        return cls(
            name=rec["name"],
            zone=rec.get("zone", ""),
            pxe_mac=rec["pxe_mac"],
            bmc_ip=rec["bmc_ip"],
            bmc_mac=rec["bmc_mac"],
            arch=rec["arch"],
            system_id=rec.get("system_id"),
            fields=rec,
        )

    def model_dump_node(self) -> dict[str, Any]:
        return self.fields


class AppliedManifest(_Envelope):
    schema_version: int = SCHEMA_VERSION
    digest: str
    applied_at: float
    source: str
    mode: str = "vm"
    # dict[str, Any] (not str): network carries the `dhcp` bool alongside the cidr strings.
    network: dict[str, Any]
    nodes: list[AppliedNode]
    bm_nodes: list[AppliedBmNode] = Field(default_factory=list)

    def node_map(self) -> dict[str, AppliedNode]:
        return {n.name: n for n in self.nodes}

    def bm_node_map(self) -> dict[str, AppliedBmNode]:
        return {n.name: n for n in self.bm_nodes}

    def model_dump_wire(self) -> dict[str, Any]:
        wire = {
            "schemaVersion": self.schema_version,
            "digest": self.digest,
            "appliedAt": self.applied_at,
            "source": self.source,
            "network": self.network,
            "nodes": [n.model_dump_node() for n in self.nodes],
        }
        if self.mode != "vm":
            wire["mode"] = self.mode
            wire["bmNodes"] = [n.model_dump_node() for n in self.bm_nodes]
        return wire


def applied_path() -> Path:
    return get_settings().state.run_dir / "fleet-applied.json"


def _resolved_nodes(fleet: Fleet) -> list[AppliedNode]:
    cidr, bmc_cidr = fleet.network.cidr, fleet.network.bmc_cidr
    return [AppliedNode.resolve(n, i, cidr, bmc_cidr) for i, n in enumerate(fleet.nodes)]


def _resolved_bm_nodes(fleet: Fleet) -> list[AppliedBmNode]:
    return [AppliedBmNode.resolve(n) for n in fleet.bm_nodes]


def _canonical_payload(fleet: Fleet) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "network": {"cidr": fleet.network.cidr, "bmc_cidr": fleet.network.bmc_cidr, "dhcp": fleet.network.dhcp},
        "nodes": [n.fields for n in _resolved_nodes(fleet)],
    }
    if fleet.mode != "vm":
        payload["mode"] = fleet.mode
        payload["bmNodes"] = [n.fields for n in _resolved_bm_nodes(fleet)]
    return payload


def fleet_digest(fleet: Fleet) -> str:
    payload = json.dumps(_canonical_payload(fleet), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode()).hexdigest()


def manifest(fleet: Fleet) -> AppliedManifest:
    return AppliedManifest(
        digest=fleet_digest(fleet),
        applied_at=time.time(),
        source=str(get_settings().paths.fleet_path),
        mode=fleet.mode,
        network={"cidr": fleet.network.cidr, "bmc_cidr": fleet.network.bmc_cidr, "dhcp": fleet.network.dhcp},
        nodes=_resolved_nodes(fleet),
        bm_nodes=_resolved_bm_nodes(fleet),
    )


def atomic_write_text(path: Path, text: str) -> None:
    """Write via temp file + os.replace so a crash mid-write never leaves a partial file — a
    reader sees either the old or complete new bytes. Caller must ensure path.parent exists."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write(fleet: Fleet) -> bool:
    rec = manifest(fleet).model_dump_wire()
    path = applied_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.warn(f"applied manifest dir not writable: {e}")
        return False
    try:
        atomic_write_text(path, json.dumps(rec))
        return True
    except Exception as e:
        log.warn(f"failed to write applied manifest: {e}")
        return False


def read() -> AppliedManifest | None:
    try:
        raw = json.loads(applied_path().read_text())
    except (FileNotFoundError, ValueError):
        return None
    try:
        return AppliedManifest(
            digest=raw.get("digest", ""),
            applied_at=raw.get("appliedAt", 0.0),
            source=raw.get("source", ""),
            mode=raw.get("mode", "vm"),
            network=raw.get("network", {}),
            nodes=[AppliedNode.from_record(n) for n in raw.get("nodes", [])],
            bm_nodes=[AppliedBmNode.from_record(n) for n in raw.get("bmNodes", [])],
        )
    except (KeyError, ValueError, TypeError):
        return None


def clear() -> None:
    applied_path().unlink(missing_ok=True)


def _mask_bmc(payload: dict[str, Any]) -> Any:
    """Display-only redaction: never echo the BMC password to the UI/CLI diff."""
    bmc = payload.get("bmc")
    if isinstance(bmc, dict) and "password" in bmc:
        return {**bmc, "password": "***"}
    return bmc


def _canon(v: Any) -> str:
    return json.dumps(v, sort_keys=True)


class NodeRef(_Envelope):
    name: str
    zone: str = ""


class DriftField(_Envelope):
    field: str
    from_: str = Field(alias="from")  # `from` is a Python keyword
    to: str


class NodeChange(_Envelope):
    name: str
    fields: list[DriftField]


class DriftSummary(_Envelope):
    added: int = 0
    removed: int = 0
    changed: int = 0
    unchanged: int = 0


class DriftNodes(_Envelope):
    added: list[NodeRef] = Field(default_factory=list)
    removed: list[NodeRef] = Field(default_factory=list)
    changed: list[NodeChange] = Field(default_factory=list)


class NetworkDrift(_Envelope):
    changed: bool = False
    fields: list[str] = Field(default_factory=list)


class FleetDiff(_Envelope):
    in_sync: bool
    severity: Severity
    desired_digest: str
    applied_digest: str | None = None
    applied_at: float | None = None
    mode_change: bool = False
    summary: DriftSummary
    nodes: DriftNodes
    network: NetworkDrift
    note: str | None = None

    def model_dump_wire(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json")


_BM_DRIFT_FIELDS = ("pxe_mac", "bmc_ip", "bmc_mac", "arch", "zone", "system_id")


def _diff_bm(desired: Fleet, applied: AppliedManifest, desired_digest: str) -> FleetDiff:
    desired_by_name = {n.name: n for n in _resolved_bm_nodes(desired)}
    applied_by_name = applied.bm_node_map()

    added: list[NodeRef] = []
    removed: list[NodeRef] = []
    changed: list[NodeChange] = []
    unchanged = 0

    for name, dn in desired_by_name.items():
        an = applied_by_name.get(name)
        if an is None:
            added.append(NodeRef(name=name, zone=dn.zone))
            continue
        drift_fields = [
            DriftField(field=k, from_=_canon(an.fields.get(k)), to=_canon(dn.fields.get(k)))
            for k in _BM_DRIFT_FIELDS
            if _canon(an.fields.get(k)) != _canon(dn.fields.get(k))
        ]
        if drift_fields:
            changed.append(NodeChange(name=name, fields=drift_fields))
        else:
            unchanged += 1
    for name, an in applied_by_name.items():
        if name not in desired_by_name:
            removed.append(NodeRef(name=name, zone=an.zone))

    # dhcp is part of the network identity for every mode (see _canonical_payload), so a bare-metal
    # fleet toggling dhcp must not read as in-sync. Default matches a pre-dhcp applied manifest.
    desired_net = {"cidr": desired.network.cidr, "bmc_cidr": desired.network.bmc_cidr, "dhcp": desired.network.dhcp}
    net_fields = [
        k
        for k in ("cidr", "bmc_cidr", "dhcp")
        if desired_net.get(k) != applied.network.get(k, False if k == "dhcp" else None)
    ]

    in_sync = not (added or removed or changed or net_fields)
    return FleetDiff(
        in_sync=in_sync,
        # A bare-metal drift is never hot-appliable: fleet.cmd_apply refuses mode != vm (exit 3) and
        # routes the operator to the lab's fleet-mode-apply op, so surface it as needs-full-rebuild.
        severity="in-sync" if in_sync else "needs-full-rebuild",
        desired_digest=desired_digest,
        applied_digest=applied.digest,
        applied_at=applied.applied_at,
        summary=DriftSummary(added=len(added), removed=len(removed), changed=len(changed), unchanged=unchanged),
        nodes=DriftNodes(added=added, removed=removed, changed=changed),
        network=NetworkDrift(changed=bool(net_fields), fields=net_fields),
        note=None,
    )


def diff(desired: Fleet, applied: AppliedManifest | None, host_os: HostOS | None = None) -> FleetDiff:
    desired_nodes = _resolved_nodes(desired)
    desired_by_name = {n.name: n for n in desired_nodes}
    desired_net = {"cidr": desired.network.cidr, "bmc_cidr": desired.network.bmc_cidr, "dhcp": desired.network.dhcp}
    desired_digest = fleet_digest(desired)

    if applied is None:
        if desired.mode != "vm":
            return FleetDiff(
                in_sync=False,
                severity="hot-appliable",
                desired_digest=desired_digest,
                applied_digest=None,
                applied_at=None,
                mode_change=True,
                summary=DriftSummary(),
                nodes=DriftNodes(),
                network=NetworkDrift(),
                note="no applied manifest — apply the bare-metal mode to bring it up",
            )
        added = [NodeRef(name=n.name, zone=n.zone) for n in desired_nodes]
        return FleetDiff(
            in_sync=not added,
            severity="needs-full-rebuild" if added else "in-sync",
            desired_digest=desired_digest,
            applied_digest=None,
            applied_at=None,
            summary=DriftSummary(added=len(added)),
            nodes=DriftNodes(added=added),
            network=NetworkDrift(),
            note="no applied manifest — bring the fleet up once to enable precise drift",
        )

    if applied.mode != desired.mode:
        return FleetDiff(
            in_sync=False,
            severity="hot-appliable",
            desired_digest=desired_digest,
            applied_digest=applied.digest,
            applied_at=applied.applied_at,
            mode_change=True,
            summary=DriftSummary(),
            nodes=DriftNodes(),
            network=NetworkDrift(),
            note=f"mode change {applied.mode!r} → {desired.mode!r} — apply via fleet-mode-apply",
        )

    if desired.mode != "vm":
        return _diff_bm(desired, applied, desired_digest)

    applied_by_name = applied.node_map()
    added: list[NodeRef] = []
    removed: list[NodeRef] = []
    changed: list[NodeChange] = []
    unchanged = 0

    for name, dn in desired_by_name.items():
        an = applied_by_name.get(name)
        if an is None:
            added.append(NodeRef(name=name, zone=dn.zone))
            continue
        d_fields, a_fields = dn.fields, an.fields
        drift_fields: list[DriftField] = []
        for k in sorted(set(d_fields) | set(a_fields)):
            # NICs can't be applied on macOS (single socket_vmnet) — apply_plan classifies a nics
            # change as NOOP there, so exclude it from drift too or the banner shows a phantom change.
            if k == "nics" and host_os == "macos":
                continue
            # compare the REAL (unmasked) canonical values so a bmc-password change is detected
            if _canon(d_fields.get(k)) == _canon(a_fields.get(k)):
                continue
            a_disp = _mask_bmc(a_fields) if k == "bmc" else a_fields.get(k)
            d_disp = _mask_bmc(d_fields) if k == "bmc" else d_fields.get(k)
            drift_fields.append(DriftField(field=k, from_=_canon(a_disp), to=_canon(d_disp)))
        if drift_fields:
            changed.append(NodeChange(name=name, fields=drift_fields))
        else:
            unchanged += 1

    for name, an in applied_by_name.items():
        if name not in desired_by_name:
            removed.append(NodeRef(name=name, zone=an.zone))

    # Backward-compat: a manifest written before a network key existed lacks it, so a bare .get()
    # returns None and would report false drift — default dhcp to False to match a pre-dhcp manifest.
    net_fields = [
        k
        for k in ("cidr", "bmc_cidr", "dhcp")
        if desired_net.get(k) != applied.network.get(k, False if k == "dhcp" else None)
    ]
    network_changed = bool(net_fields)
    in_sync = not (added or removed or changed or network_changed)

    identity_changed = network_changed or any(any(f.field in IDENTITY_FIELDS for f in n.fields) for n in changed)
    # hot fields include bmc so a creds-only change is hot-appliable (apply_plan also classifies
    # fields=={'bmc'} as HOT_NODE, so banner and plan agree).
    _hot_test = HOT_FIELDS + DISK_FIELDS + ("bmc",)

    if in_sync:
        severity: Severity = "in-sync"
    elif identity_changed:
        severity = "needs-full-rebuild"
    elif added or removed or any(any(f.field in _hot_test for f in n.fields) for n in changed):
        severity = "hot-appliable"
    else:
        severity = "needs-full-rebuild"

    return FleetDiff(
        in_sync=in_sync,
        severity=severity,
        desired_digest=desired_digest,
        applied_digest=applied.digest,
        applied_at=applied.applied_at,
        summary=DriftSummary(added=len(added), removed=len(removed), changed=len(changed), unchanged=unchanged),
        nodes=DriftNodes(added=added, removed=removed, changed=changed),
        network=NetworkDrift(changed=network_changed, fields=net_fields),
        note=None,
    )


def drift_summary_line(d: FleetDiff) -> str:
    if d.mode_change:
        return "⚠ fleet mode change pending — apply via the fleet-mode-apply op"
    if d.applied_at is None and not d.in_sync:
        return "fleet: not yet applied — run `task up` to bring it up"
    if d.in_sync:
        return "fleet: in sync"
    s = d.summary
    counts = {"added": s.added, "removed": s.removed, "changed": s.changed}
    parts = [f"{counts[k]} {k}" for k in ("added", "removed", "changed") if counts[k]]
    # network (CIDR) drift counts as one change even when no per-node field moved — matches the
    # control-center banner, which would otherwise disagree with this line.
    if d.network.changed:
        parts.append("network")
    total = s.added + s.removed + s.changed + (1 if d.network.changed else 0)
    return f"⚠ {total} pending fleet changes ({', '.join(parts)}) — {APPLY_HINT_CLI}"
