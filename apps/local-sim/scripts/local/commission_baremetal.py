from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from local.config import get_settings
from local.hub_client import HubClient
from local.logger import log
from local.schema import BareMetalNode

# Re-exported so callers/tests keep importing `BareMetalNode` from this module.
__all__ = ["BareMetalNode", "BmcCreds", "CommissionError", "select_nodes"]

ZONE_ID = "00000000-0000-0000-0000-111111111111"

POLL_INTERVAL_SECONDS = 20
DEFAULT_TIMEOUT_MINUTES = 45


class CommissionError(RuntimeError):
    pass


@dataclass(frozen=True)
class BmcCreds:
    username: str
    password: str


POLL_QUALIFIED = "qualified"
POLL_FAILED = "failed"
POLL_IN_PROGRESS = "in_progress"
POLL_ABSENT = "absent"


def classify_progress_item(item: dict[str, Any] | None) -> str:
    if item is None:
        return POLL_ABSENT
    if item.get("lifecycleFailed") is True:
        return POLL_FAILED
    if item.get("lifecycleQualified") is True:
        return POLL_QUALIFIED
    return POLL_IN_PROGRESS


def find_progress_item(body: dict[str, Any] | None, device_id: str) -> dict[str, Any] | None:
    if not isinstance(body, dict):
        return None
    data = body.get("data")
    if not isinstance(data, list):
        return None
    for entry in data:
        if isinstance(entry, dict) and entry.get("deviceId") == device_id:
            return entry
    return None


def describe_saga_progress(item: dict[str, Any]) -> str:
    steps = item.get("sagaSteps")
    if not isinstance(steps, list) or not steps:
        status = item.get("deviceStatus") or "?"
        return f"no saga steps yet (deviceStatus={status})"
    running = [s for s in steps if isinstance(s, dict) and s.get("status") == "running"]
    current = running[-1] if running else (steps[-1] if isinstance(steps[-1], dict) else {})
    name = current.get("name") or "?"
    phase = current.get("phase") or "?"
    status = current.get("status") or "?"
    done = sum(1 for s in steps if isinstance(s, dict) and s.get("status") == "complete")
    return f"phase={phase} step={name} ({status}) [{done}/{len(steps)} complete]"


def failure_detail(item: dict[str, Any]) -> str:
    steps = item.get("sagaSteps")
    if isinstance(steps, list):
        for step in steps:
            if isinstance(step, dict) and step.get("status") == "failed":
                err = step.get("error") or "no error detail"
                return f"step {step.get('name')!r} ({step.get('phase')}): {err}"
    return "no failed-step detail in progress feed"


def _devenv_state_dir() -> Path:
    env = os.environ.get("DEVENV_STATE")
    if env:
        return Path(env)
    from local.config import REPO

    return REPO / ".devenv" / "state"


def bmc_creds_path() -> Path:
    return _devenv_state_dir() / "baremetal" / "bmc-creds.json"


def load_baremetal_nodes(fleet_path: Path | None = None) -> list[BareMetalNode]:
    path = fleet_path or get_settings().paths.fleet_path
    if not Path(path).exists():
        raise CommissionError(f"fleet.yml not found at {path} — is the stack up?")
    raw = yaml.safe_load(Path(path).read_text())
    if not isinstance(raw, dict):
        raise CommissionError(f"fleet.yml at {path} is not a mapping")
    baremetal = raw.get("baremetal")
    if not isinstance(baremetal, dict):
        raise CommissionError(
            f"fleet.yml at {path} has no 'baremetal' block — the bare-metal plane is off "
            "(add a bare-metal machine on Fleet nodes and re-render)"
        )
    nodes_raw = baremetal.get("nodes")
    if not isinstance(nodes_raw, list) or not nodes_raw:
        raise CommissionError(f"fleet.yml 'baremetal.nodes' is empty at {path}")
    default_arch = baremetal.get("arch") if isinstance(baremetal.get("arch"), str) else None

    nodes: list[BareMetalNode] = []
    for entry in nodes_raw:
        if not isinstance(entry, dict):
            raise CommissionError(f"baremetal node entry is not a mapping: {entry!r}")
        try:
            name = str(entry["name"])
            bmc_ip = str(entry["bmc_ip"])
            bmc_mac = str(entry["bmc_mac"])
            pxe_mac = str(entry["pxe_mac"])
        except KeyError as e:
            raise CommissionError(f"baremetal node {entry.get('name', '?')!r} missing required field {e}") from None
        arch = entry.get("arch")
        try:
            nodes.append(
                BareMetalNode(
                    name=name,
                    bmc_ip=bmc_ip,
                    bmc_mac=bmc_mac,
                    pxe_mac=pxe_mac,
                    arch=str(arch) if isinstance(arch, str) else default_arch,
                    system_id=str(entry["system_id"]) if entry.get("system_id") else None,
                )
            )
        except ValidationError as e:
            raise CommissionError(f"baremetal node {name!r} failed validation: {e}") from None
    return nodes


def load_bmc_creds(node_name: str, creds_path: Path | None = None) -> BmcCreds:
    path = creds_path or bmc_creds_path()
    if not Path(path).exists():
        raise CommissionError(
            f"BMC creds file not found at {path} — write it (0600) as "
            '{"<node>": {"user": "...", "pass": "..."}} before commissioning'
        )
    try:
        blob = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise CommissionError(f"failed to read BMC creds file {path}: {e}") from None
    if not isinstance(blob, dict):
        raise CommissionError(f"BMC creds file {path} is not a JSON object")
    # Per-node entry wins, else the shared `defaults` — mirrors the node -> defaults -> admin/admin
    # precedence the seed uses, so a single-box bench (creds only under `defaults`) resolves.
    entry = blob.get(node_name)
    source = node_name
    if not isinstance(entry, dict):
        entry = blob.get("defaults")
        source = "defaults"
    if not isinstance(entry, dict):
        raise CommissionError(f"BMC creds file {path} has no entry for node {node_name!r} or 'defaults'")
    user = entry.get("user")
    password = entry.get("pass")
    if not isinstance(user, str) or not user or not isinstance(password, str) or not password:
        raise CommissionError(f"BMC creds {source!r} in {path} must have non-empty string 'user' and 'pass'")
    return BmcCreds(username=user, password=password)


def _commission_one(client: HubClient, node: BareMetalNode, creds: BmcCreds) -> str:
    log.info(f"commissioning {node.name} (bmc {node.bmc_ip}, pxe {node.pxe_mac})")
    device_input: dict[str, Any] = {
        "bmcMac": node.bmc_mac,
        "bmcIp": node.bmc_ip,
        "bmcUsername": creds.username,
        "bmcPassword": creds.password,
        "nicMac": node.pxe_mac,
    }
    code, body = client.commission_zone_devices(ZONE_ID, [device_input])
    if code != 200 or not isinstance(body, dict):
        raise CommissionError(f"{node.name}: commission call failed ({code}): {body}")
    device_ids = body.get("deviceIds")
    if not isinstance(device_ids, list) or not device_ids or not isinstance(device_ids[0], str):
        failed = body.get("failedDevices")
        raise CommissionError(f"{node.name}: commission returned no deviceIds (failedDevices={failed})")
    device_id = device_ids[0]
    log.success(f"{node.name}: commissioning device {device_id} created")
    return device_id


def _poll_until_terminal(client: HubClient, node: BareMetalNode, device_id: str, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        code, body = client.commissioning_progress(ZONE_ID)
        if code != 200:
            log.warn(f"{node.name}: progress fetch returned {code}; will retry")
            item = None
        else:
            item = find_progress_item(body, device_id)
        signal = classify_progress_item(item)

        if signal == POLL_QUALIFIED:
            log.success(f"{node.name}: qualified (lifecycleStatus INVENTORY)")
            return
        if signal == POLL_FAILED:
            raise CommissionError(f"{node.name}: commissioning failed — {failure_detail(item)}")
        if signal == POLL_ABSENT:
            log.detail(f"{node.name}: not yet in the progress feed")
        else:
            log.detail(f"{node.name}: {describe_saga_progress(item)}")

        if time.monotonic() >= deadline:
            raise CommissionError(
                f"{node.name}: timed out after {timeout_seconds}s waiting to qualify (last signal: {signal})"
            )
        time.sleep(POLL_INTERVAL_SECONDS)


def _verify_device(client: HubClient, node: BareMetalNode, device_id: str) -> None:
    code, body = client.get_server(device_id)
    if code != 200 or not isinstance(body, dict):
        raise CommissionError(f"{node.name}: get_server({device_id}) failed ({code}): {body}")

    role = str(body.get("role") or "")
    if "server" not in role.lower():
        raise CommissionError(f"{node.name}: expected a Server role after acknowledge, got role={role!r}")

    status = body.get("status")
    status_value = status.get("value") if isinstance(status, dict) else status
    if str(status_value or "").upper() != "ACTIVE":
        raise CommissionError(f"{node.name}: expected status ACTIVE after acknowledge, got {status_value!r}")

    specs = body.get("specs")
    if not isinstance(specs, dict) or not specs:
        raise CommissionError(f"{node.name}: acknowledged device has no collected specs")

    cpu = specs.get("cpu") if isinstance(specs.get("cpu"), dict) else {}
    mem = specs.get("memory") if isinstance(specs.get("memory"), dict) else {}
    storage = specs.get("storage") if isinstance(specs.get("storage"), dict) else {}
    log.success(
        f"{node.name}: verified ACTIVE Server — "
        f"cpu={cpu.get('model') or '?'} ({cpu.get('totalCores') or '?'} cores), "
        f"mem={mem.get('total') or '?'}GB, storage={storage.get('total') or '?'}GB"
    )


def commission_node(client: HubClient, node: BareMetalNode, creds: BmcCreds, timeout_seconds: int) -> None:
    device_id = _commission_one(client, node, creds)
    _poll_until_terminal(client, node, device_id, timeout_seconds)

    code, body = client.acknowledge_commissioning(ZONE_ID, device_id)
    if code != 200:
        raise CommissionError(f"{node.name}: acknowledge failed ({code}): {body}")
    log.success(f"{node.name}: acknowledged (promoted to Server)")

    _verify_device(client, node, device_id)
    log.info(f"{node.name}: commissioning complete")


def select_nodes(nodes: list[BareMetalNode], name: str | None) -> list[BareMetalNode]:
    if name is None:
        return nodes
    selected = [n for n in nodes if n.name == name]
    if not selected:
        available = ", ".join(n.name for n in nodes)
        raise CommissionError(f"no bare-metal node named {name!r} (available: {available})")
    return selected


def run(name: str | None, timeout_minutes: int) -> int:
    timeout_seconds = timeout_minutes * 60
    nodes = select_nodes(load_baremetal_nodes(), name)
    log.info(f"commissioning {len(nodes)} bare-metal node(s), timeout {timeout_minutes}m each")

    client = HubClient()
    failures: list[str] = []
    for node in nodes:
        try:
            creds = load_bmc_creds(node.name)
            client.sign_in()
            commission_node(client, node, creds, timeout_seconds)
        except CommissionError as e:
            log.error(str(e))
            failures.append(node.name)

    if failures:
        log.error(f"commissioning FAILED for: {', '.join(failures)}")
        return 1
    log.info("all nodes commissioned successfully")
    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m local.commission_baremetal",
        description="Drive the hub bare-metal commissioning loop (commission → poll → acknowledge → verify).",
    )
    parser.add_argument("--node", default=None, help="Bare-metal node name (default: all baremetal nodes)")
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_MINUTES,
        metavar="MIN",
        help=f"Per-node poll timeout in minutes (default: {DEFAULT_TIMEOUT_MINUTES})",
    )
    parser.add_argument(
        "--yes-wipe",
        action="store_true",
        help=(
            "REQUIRED confirmation: commissioning WIPES the target disk "
            "(commission saga disk_wipe + qualify deprovision)."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    if not args.yes_wipe:
        log.error(
            "refusing to run without --yes-wipe. Commissioning WIPES the target machine's disk "
            "(commission saga disk_wipe + qualify deprovision). Pass --yes-wipe to confirm."
        )
        return 2
    if args.timeout <= 0:
        log.error(f"--timeout must be a positive number of minutes, got {args.timeout}")
        return 2
    log.warn("commissioning WIPES the target disk(s) — proceeding because --yes-wipe was given")
    try:
        return run(args.node, args.timeout)
    except CommissionError as e:
        log.error(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
