"""Classify a fleet drift diff into the cheapest safe per-node apply action (pure, no I/O).
Index shifts surface as a surviving node whose ip/bmc_ip/index changed → full rebuild. The plan
camelCases on the wire to match the Zod ``ApplyPlanSchema``; ``PlanItem.action`` is the enum value."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from local.applied import DISK_FIELDS, HOT_FIELDS, IDENTITY_FIELDS, FleetDiff, NodeChange
from local.host_os import HostOS


class NodeAction(StrEnum):
    NOOP = "noop"
    HOT_NODE = "hot-node"
    NODE_DISK = "node-disk"
    ADD_NODE = "add-node"
    REMOVE_TERMINAL_NODE = "remove-terminal-node"
    FULL_REBUILD_REQUIRED = "full-rebuild-required"


_ETA = {
    NodeAction.NOOP: 0,
    NodeAction.HOT_NODE: 10,
    NodeAction.NODE_DISK: 12,
    NodeAction.ADD_NODE: 90,
    NodeAction.REMOVE_TERMINAL_NODE: 5,
    NodeAction.FULL_REBUILD_REQUIRED: 240,
}


class _Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PlanItem(_Wire):
    name: str
    action: NodeAction
    reason: str
    fields: list[str] = Field(default_factory=list)
    eta_sec: int
    data_loss: bool = False


class ApplyPlan(_Wire):
    fallback_full_rebuild: bool = False
    reason: str | None = None
    data_loss: bool = False
    eta_sec: int = 0
    items: list[PlanItem] = Field(default_factory=list)

    def model_dump_wire(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")  # mode='json' → enum.value


def _item(name: str, action: NodeAction, reason: str, fields: list[str], data_loss: bool) -> PlanItem:
    return PlanItem(name=name, action=action, reason=reason, fields=fields, eta_sec=_ETA[action], data_loss=data_loss)


def _classify_changed(node: NodeChange, host_os: HostOS) -> tuple[NodeAction, str, bool]:
    fields = {f.field for f in node.fields}
    ident = fields & set(IDENTITY_FIELDS)
    if ident:
        return NodeAction.FULL_REBUILD_REQUIRED, f"{', '.join(sorted(ident))} changed — identity/IP shift", False
    # `bmc` is one nested-object key in Node.model_dump() — a creds-only change is hot-appliable.
    if fields == {"bmc"}:
        return NodeAction.HOT_NODE, "bmc creds changed — restart ipmi_sim/sushy", False
    disk = fields & set(DISK_FIELDS)
    if disk:
        return NodeAction.NODE_DISK, f"{', '.join(sorted(disk))} changed — recreates this node's disk", True
    if host_os == "macos" and fields == {"nics"}:
        return NodeAction.NOOP, "nics change ignored on macOS (single socket_vmnet)", False
    hot = fields & set(HOT_FIELDS)
    if hot:
        return NodeAction.HOT_NODE, f"{', '.join(sorted(hot))} changed — power-cycle", False
    return NodeAction.NOOP, "no instantiating change", False


def build_apply_plan(diff: FleetDiff, host_os: HostOS) -> ApplyPlan:
    # no applied manifest means we have no per-node baseline; agree with diff()'s severity.
    if diff.applied_digest is None:
        return ApplyPlan(fallback_full_rebuild=True, reason="no applied manifest — full rebuild")

    nodes = diff.nodes
    items: list[PlanItem] = []
    index_shift = any("index" in {f.field for f in cn.fields} for cn in nodes.changed)

    for cn in nodes.changed:
        action, reason, data_loss = _classify_changed(cn, host_os)
        items.append(_item(cn.name, action, reason, [f.field for f in cn.fields], data_loss))

    for rn in nodes.removed:
        if index_shift:
            items.append(
                _item(
                    rn.name,
                    NodeAction.FULL_REBUILD_REQUIRED,
                    "removal shifts downstream node indices",
                    [],
                    False,
                )
            )
        else:
            items.append(_item(rn.name, NodeAction.REMOVE_TERMINAL_NODE, "drop tail node", [], False))

    for an in nodes.added:
        if index_shift:
            items.append(
                _item(
                    an.name,
                    NodeAction.FULL_REBUILD_REQUIRED,
                    "insert shifts downstream node indices",
                    [],
                    False,
                )
            )
        else:
            items.append(_item(an.name, NodeAction.ADD_NODE, "append new node", [], False))

    if diff.network.changed:
        # NOTE: dhcp-only changes should ideally use lighter refresh (tracked separately),
        # but today ANY network field change forces rebuild.
        items.append(
            _item(
                "network",
                NodeAction.FULL_REBUILD_REQUIRED,
                f"network changed ({', '.join(diff.network.fields)}) — addresses may move, full rebuild required",
                diff.network.fields,
                False,
            )
        )

    fallback = any(i.action == NodeAction.FULL_REBUILD_REQUIRED for i in items)
    reason = next((i.reason for i in items if i.action == NodeAction.FULL_REBUILD_REQUIRED), None)
    data_loss = any(i.data_loss for i in items)
    eta = _ETA[NodeAction.FULL_REBUILD_REQUIRED] if fallback else sum(_ETA[i.action] for i in items)

    return ApplyPlan(fallback_full_rebuild=fallback, reason=reason, data_loss=data_loss, eta_sec=eta, items=items)
