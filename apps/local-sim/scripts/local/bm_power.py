#!/usr/bin/env python
"""Power + boot-source-to-PXE primitive for the bare-metal bench box: boot the real box into
brokkr-live via its BMC, Redfish-primary with an IPMI fallback. A Redfish 401/403 is auth (stays a
seal-reseed error, no IPMI fallback); a transport-unreachable/non-auth error falls back to ipmitool.
``action="auto"`` reads PowerState first (Off → on, On → reset) so an unconditional reset can't fail
on an off INVENTORY box. :func:`assert_target` fires before any transport so a stale fleet.yml can't
power the wrong host."""

from __future__ import annotations

import argparse
import base64
import json
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Literal

from local.commission_baremetal import (
    BareMetalNode,
    BmcCreds,
    CommissionError,
    load_baremetal_nodes,
    load_bmc_creds,
)
from local.derived import bm_device_uuid
from local.logger import log

# Concrete power actions issued to a transport.
PowerAction = Literal["on", "reset", "powercycle"]
# Caller-facing action: "auto" reads PowerState first and picks on/reset per state.
Action = Literal["auto", "on", "reset", "powercycle"]

# ResetType selection: the action's preference list is intersected with the BMC's advertised
# allowable set, first match wins (ported exactly from apps/local-lab fleet.service.ts).
_RESET_TYPES: dict[PowerAction, list[str]] = {
    "on": ["On"],
    "reset": ["ForceRestart", "GracefulRestart"],
    "powercycle": ["PowerCycle", "ForceRestart"],
}

# ipmitool `chassis power` verb per action (mirrors apps/bridge ipmi/handlers/power.ts
# POWER_OPS). `powercycle` maps to `cycle`; `reset` to `reset`.
_IPMI_POWER_VERB: dict[PowerAction, str] = {
    "on": "on",
    "reset": "reset",
    "powercycle": "cycle",
}

_SEAL_RESEED_HINT = (
    "BMC rejected the credentials (auth) — the zone BMC seal is likely stale after a "
    "datastore wipe. Re-seal it: `task up` (re-seals on bring-up) or "
    "`pnpm --filter api seed:baremetal-bmc`, then retry."
)


class BmPowerError(RuntimeError):
    """Fatal bm_power failure (unreachable BMC, wrong machine, unsupported action)."""


class RedfishAuthError(BmPowerError):
    """Redfish returned 401/403 — creds are wrong/stale. Never triggers IPMI fallback."""


class _RedfishUnusable(RuntimeError):
    """Redfish can't perform the op (transport-unreachable or non-auth HTTP error) → triggers the
    IPMI fallback. Module-internal: always caught inside ``boot_into_live``; must never escape."""

    def __init__(self, message: str, code: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.body = body


# Node resolution + wrong-machine guard


def resolve_bm_node(nodes: list[BareMetalNode], arg: str) -> BareMetalNode:
    """Match ``arg`` against a node's ``name`` OR ``pxe_mac`` (both lowered); a miss raises listing
    the available names + MACs. Accepts a MAC so ``run-plan.ts`` can pass the boot MAC in scope."""
    want = arg.strip().lower()
    for n in nodes:
        if n.name.lower() == want or n.pxe_mac.lower() == want:
            return n
    names = ", ".join(n.name for n in nodes) or "(none)"
    macs = ", ".join(n.pxe_mac for n in nodes) or "(none)"
    raise BmPowerError(f"no bare-metal node matching {arg!r} (names: {names}; pxe_macs: {macs})")


def assert_target(node: BareMetalNode, expected_uuid: str) -> None:
    """WRONG-MACHINE guard (must pass before any destructive transport): ``bm_device_uuid(pxe_mac)``
    must equal ``expected_uuid`` (from ``SIM_LC_DEVICE_ID``), else fleet.yml resolved a different box."""
    resolved = bm_device_uuid(node.pxe_mac)
    if resolved != expected_uuid:
        raise BmPowerError(
            f"wrong-machine guard: node {node.name!r} (pxe_mac {node.pxe_mac}) resolves to "
            f"device {resolved}, not the expected {expected_uuid}. Refusing to power/boot the "
            "wrong box. Re-run `sim:bm:reconcile` + re-seed to realign fleet.yml with the hub."
        )


# Redfish HTTP (urllib + verify-off ssl context; matches bmc_capture.py)


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # self-signed BMC certs — matches TS rejectUnauthorized:false
    return ctx


def _auth_header(creds: BmcCreds) -> str:
    raw = f"{creds.username}:{creds.password}".encode()
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _redfish_request(
    base: str,
    path: str,
    auth: str,
    *,
    method: str,
    timeout: int,
    body: dict | None = None,
    extra_headers: dict[str, str] | None = None,
) -> dict:
    """One Redfish request: raises :class:`RedfishAuthError` on 401/403, :class:`_RedfishUnusable`
    on transport failure or non-auth HTTP error."""
    url = f"{base}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": auth, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx()) as resp:
            raw = resp.read()
            if not raw:
                return {}
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise RedfishAuthError(_SEAL_RESEED_HINT) from None
        # body carries the vendor ExtendedInfo the boot-override path parses for a FutureState URI.
        raise _RedfishUnusable(
            f"Redfish {method} {path} → HTTP {e.code}", code=e.code, body=e.read().decode("utf8", "replace")
        ) from None
    except (urllib.error.URLError, ssl.SSLError, TimeoutError, ConnectionError, OSError) as e:
        raise _RedfishUnusable(f"Redfish {method} {path} unreachable: {e}") from None


def _resolve_system_path(base: str, auth: str, node: BareMetalNode, timeout: int) -> str:
    if node.system_id:
        return f"/redfish/v1/Systems/{node.system_id}"
    body = _redfish_request(base, "/redfish/v1/Systems", auth, method="GET", timeout=timeout)
    members = body.get("Members")
    first = members[0] if isinstance(members, list) and members else None
    ref = first.get("@odata.id") if isinstance(first, dict) else None
    if not isinstance(ref, str):
        raise BmPowerError("no ComputerSystem found under /redfish/v1/Systems")
    return ref


def _boot_allowable(system: dict) -> list[str]:
    boot = system.get("Boot")
    if not isinstance(boot, dict):
        return []
    vals = boot.get("BootSourceOverrideEnabled@Redfish.AllowableValues")
    return [v for v in vals if isinstance(v, str)] if isinstance(vals, list) else []


def _reset_allowable(system: dict) -> list[str]:
    actions = system.get("Actions")
    reset = actions.get("#ComputerSystem.Reset") if isinstance(actions, dict) else None
    vals = reset.get("ResetType@Redfish.AllowableValues") if isinstance(reset, dict) else None
    return [v for v in vals if isinstance(v, str)] if isinstance(vals, list) else []


def _etag_for(base: str, auth: str, path: str, timeout: int) -> str | None:
    """ETag of a resource, read from its own body. Boards that enforce If-Match on PATCH reject an
    unconditional write with 428, so the value has to come from a fresh GET each time."""
    doc = _redfish_request(base, path, auth, method="GET", timeout=timeout)
    etag = doc.get("@odata.etag")
    return etag if isinstance(etag, str) and etag else None


def _future_state_uri(body: str) -> str | None:
    """The pending-settings URI an AMI board names when it refuses a Boot write on the current-state
    resource: `Support of this Operation for Boot Properties is moved to FutureState URI(<uri>)`."""
    match = re.search(r"FutureState URI\(([^)]+)\)", body)
    return match.group(1) if match else None


def _patch_boot(base: str, auth: str, path: str, boot: dict, timeout: int) -> str:
    """PATCH a Boot object, following one FutureState redirect; returns the path that accepted it
    (the caller must read back from THAT resource — a pending-settings write leaves current state
    untouched until the box consumes it, so a readback on the current-state resource always looks
    like a silent failure)."""
    etag = _etag_for(base, auth, path, timeout)
    headers = {"If-Match": etag} if etag else None
    try:
        _redfish_request(base, path, auth, method="PATCH", timeout=timeout, body={"Boot": boot}, extra_headers=headers)
        return path
    except _RedfishUnusable as first:
        pending = _future_state_uri(first.body)
        if pending is None or pending == path:
            raise
        log.detail(f"redfish: boot properties moved to {pending}; retrying there")
        pending_etag = _etag_for(base, auth, pending, timeout)
        pending_headers = {"If-Match": pending_etag} if pending_etag else None
        _redfish_request(
            base, pending, auth, method="PATCH", timeout=timeout, body={"Boot": boot}, extra_headers=pending_headers
        )
        return pending


def set_boot_pxe_redfish(base: str, auth: str, system_path: str, timeout: int) -> None:
    """Set BootSourceOverride to PXE/UEFI (Continuous when allowable, else Once) and read it back.
    Raises :class:`_RedfishUnusable` when the board accepts the PATCH but leaves the override unset.
    BootSourceOverrideMode is always sent — AMI rejects a Boot PATCH that omits it."""
    system = _redfish_request(base, system_path, auth, method="GET", timeout=timeout)
    allowable = _boot_allowable(system)
    enabled = "Continuous" if ("Continuous" in allowable or not allowable) else "Once"
    written_to = _patch_boot(
        base,
        auth,
        system_path,
        {
            "BootSourceOverrideTarget": "Pxe",
            "BootSourceOverrideMode": "UEFI",
            "BootSourceOverrideEnabled": enabled,
        },
        timeout,
    )
    after = _redfish_request(base, written_to, auth, method="GET", timeout=timeout)
    boot = after.get("Boot") if isinstance(after.get("Boot"), dict) else {}
    target = boot.get("BootSourceOverrideTarget")
    active = boot.get("BootSourceOverrideEnabled")
    if target != "Pxe" or active in (None, "Disabled"):
        raise _RedfishUnusable(
            f"board accepted but ignored the Redfish PXE override at {written_to} "
            f"(BootSourceOverrideTarget={target!r}, BootSourceOverrideEnabled={active!r}) — "
            "using ipmitool chassis bootdev pxe options=persistent,efiboot instead"
        )
    log.detail(f"redfish: BootSourceOverride → Pxe/UEFI/{enabled} at {written_to} (readback {target}/{active})")


def _redfish_reset(base: str, auth: str, system_path: str, reset_type: str, timeout: int) -> None:
    _redfish_request(
        base,
        f"{system_path}/Actions/ComputerSystem.Reset",
        auth,
        method="POST",
        timeout=timeout,
        body={"ResetType": reset_type},
    )


def _redfish_power_state(base: str, auth: str, system_path: str, timeout: int) -> str:
    system = _redfish_request(base, system_path, auth, method="GET", timeout=timeout)
    state = system.get("PowerState")
    return state if isinstance(state, str) else "Unknown"


def bm_reset_redfish(base: str, auth: str, system_path: str, action: PowerAction, timeout: int) -> str:
    """Redfish power action, returns PowerState. Only ``powercycle`` gets the ForceOff→poll-Off→On
    fallback. ``system_path`` is resolved once by the caller and threaded in to avoid a re-GET."""
    system = _redfish_request(base, system_path, auth, method="GET", timeout=timeout)
    allowable = _reset_allowable(system)
    reset_type = next((t for t in _RESET_TYPES[action] if not allowable or t in allowable), None)
    if reset_type is None:
        if action == "powercycle" and (not allowable or "ForceOff" in allowable):
            _redfish_reset(base, auth, system_path, "ForceOff", timeout)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if _redfish_power_state(base, auth, system_path, timeout) == "Off":
                    break
                time.sleep(2)
            _redfish_reset(base, auth, system_path, "On", timeout)
            return _redfish_power_state(base, auth, system_path, timeout)
        raise BmPowerError(f"BMC does not support {action} (allowable ResetTypes: {', '.join(allowable) or 'unknown'})")
    _redfish_reset(base, auth, system_path, reset_type, timeout)
    state = _redfish_power_state(base, auth, system_path, timeout)
    log.detail(f"redfish: {action} → {reset_type} (PowerState={state})")
    return state


# IPMI fallback (ipmitool over lanplus; mirrors apps/bridge ipmi handlers)


def _ipmitool_base(node: BareMetalNode, creds: BmcCreds) -> list[str]:
    # Match apps/bridge command.ts buildBaseCommand: -H/-U/-P on argv, -I lanplus.
    # The app itself passes -P on argv (no keyring/env mechanism), so we mirror it.
    return [
        "ipmitool",
        "-I",
        "lanplus",
        "-H",
        node.bmc_ip,
        "-U",
        creds.username,
        "-P",
        creds.password,
    ]


def _redact_argv(argv: list[str], password: str) -> str:
    """Argv as a string with the password element replaced by ``***``, redacted by value not
    position — creds.password must never reach any log/stderr/exception string."""
    return " ".join("***" if a == password else a for a in argv)


def _run_ipmitool(argv: list[str], creds: BmcCreds, timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        # A hung BMC must surface as BmPowerError (the documented type boot_into_live/main/
        # reset_device catch), not an unhandled TimeoutExpired traceback.
        raise BmPowerError(
            f"ipmitool `{_redact_argv(argv, creds.password)}` timed out after {timeout}s (BMC unresponsive)"
        ) from None
    if proc.returncode != 0:
        stderr = (proc.stderr or "").replace(creds.password, "***").strip()
        raise BmPowerError(f"ipmitool `{_redact_argv(argv, creds.password)}` failed (exit {proc.returncode}): {stderr}")
    return proc


def ipmi_power_status(node: BareMetalNode, creds: BmcCreds, timeout: int) -> str | None:
    """`chassis power status` → "on" / "off" / None (unreadable). Picks a power-state-aware
    action on the IPMI fallback path (Off→on, On→reset)."""
    argv = [*_ipmitool_base(node, creds), "chassis", "power", "status"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        # A hung read or exec failure degrades to an unreadable status (→ None, action="on");
        # swallowing also avoids leaking creds.password via an unhandled exception's cmd attribute.
        return None
    if proc.returncode != 0:
        return None
    text = (proc.stdout or "").lower()
    if "power is on" in text:
        return "on"
    if "power is off" in text:
        return "off"
    return None


def set_boot_pxe_ipmi(node: BareMetalNode, creds: BmcCreds, timeout: int) -> None:
    """UEFI PXE boot-source over IPMI. Options match the bridge saga (oob/ipmi/handlers/power.ts)
    so both writers leave the box in the same boot state."""
    argv = [*_ipmitool_base(node, creds), "chassis", "bootdev", "pxe", "options=persistent,efiboot"]
    _run_ipmitool(argv, creds, timeout)
    log.detail("ipmi: chassis bootdev pxe options=persistent,efiboot")


def bm_reset_ipmi(node: BareMetalNode, creds: BmcCreds, action: PowerAction, timeout: int) -> str:
    """IPMI power action: `chassis power on|reset|cycle`. Returns the verb used
    (IPMI has no rich PowerState echo like Redfish)."""
    verb = _IPMI_POWER_VERB[action]
    argv = [*_ipmitool_base(node, creds), "chassis", "power", verb]
    _run_ipmitool(argv, creds, timeout)
    log.detail(f"ipmi: chassis power {verb}")
    return f"ipmi:{verb}"


# Composed primitive: guard → set-boot-pxe → power (Redfish-first, IPMI fallback)


def _resolve_auto_action_redfish(base: str, auth: str, system_path: str, timeout: int) -> PowerAction:
    """Power-state-aware action for Redfish: On → "reset", Off/absent/unknown → "on" (a reset on an
    off box fails on many BMCs; On is idempotent on an already-on box)."""
    state = _redfish_power_state(base, auth, system_path, timeout)
    return "reset" if state == "On" else "on"


def _resolve_auto_action_ipmi(node: BareMetalNode, creds: BmcCreds, timeout: int) -> PowerAction:
    """Power-state-aware action for IPMI: on → "reset", off/unreadable → "on" (`chassis power on` is
    idempotent, so an unreadable status degrades safely rather than risking a reset on an off box)."""
    return "reset" if ipmi_power_status(node, creds, timeout) == "on" else "on"


def bm_status(node: BareMetalNode, creds: BmcCreds, expected_uuid: str, *, timeout: int = 60) -> str:
    """Redfish PowerState. GETs only, wrong-machine guard active, and no IPMI fallback: a degraded
    read would mask a dead Redfish surface every mutating path depends on."""
    assert_target(node, expected_uuid)
    base = f"https://{node.bmc_ip}"
    auth = _auth_header(creds)
    try:
        system_path = _resolve_system_path(base, auth, node, timeout)
        return _redfish_power_state(base, auth, system_path, timeout)
    except _RedfishUnusable as e:
        raise BmPowerError(f"{node.name}: Redfish status read failed: {e}") from None


def boot_into_live(
    node: BareMetalNode,
    creds: BmcCreds,
    expected_uuid: str,
    action: Action = "auto",
    *,
    timeout: int = 60,
) -> str:
    """Guard, then set PXE boot-source + power the box into brokkr-live; returns a power-state
    string. ``action="auto"`` reads PowerState first (Off → "on", On → "reset"); Redfish-first with
    an IPMI fallback on any non-auth Redfish failure — a 401/403 propagates as a seal-reseed error."""
    assert_target(node, expected_uuid)
    base = f"https://{node.bmc_ip}"
    auth = _auth_header(creds)
    try:
        # Resolve the ComputerSystem path once and thread it through both the
        # boot-source PATCH and the reset POST (avoids a double GET /Systems).
        system_path = _resolve_system_path(base, auth, node, timeout)
        resolved = _resolve_auto_action_redfish(base, auth, system_path, timeout) if action == "auto" else action
        set_boot_pxe_redfish(base, auth, system_path, timeout)
        state = bm_reset_redfish(base, auth, system_path, resolved, timeout)
        log.info(f"{node.name}: redfish {resolved} → brokkr-live (state={state})")
        return state
    except RedfishAuthError:
        raise
    except (_RedfishUnusable, BmPowerError) as e:
        log.warn(f"{node.name}: Redfish unusable ({e}) — falling back to IPMI")
        resolved = _resolve_auto_action_ipmi(node, creds, timeout) if action == "auto" else action
        set_boot_pxe_ipmi(node, creds, timeout)
        state = bm_reset_ipmi(node, creds, resolved, timeout)
        log.info(f"{node.name}: ipmi {resolved} → brokkr-live (state={state})")
        return state


# --wait-ip poll (proof-only; predicate byte-identical to hub-db.ts getDataIpByBootMac)


def _wait_for_data_ip(dsn: str, boot_mac: str, timeout: int, interval: int = 10) -> str | None:
    """Poll the hub DB until the pxe_mac's eth0 IPv4 IpAddress appears ACTIVE. Predicate
    byte-identical to ``getDataIpByBootMac`` so this proof poll and the TS poll agree."""
    import psycopg  # local import: only the --wait-ip proof path needs a DB driver

    sql = (
        'SELECT host(ip.address) AS "dataIp" '
        'FROM "Interface" ii '
        'JOIN "IpAddress" ip ON ip."interfaceId" = ii.id '
        'WHERE lower(ii."macAddress") = lower(%s) '
        '  AND ii."deletedAt" IS NULL '
        '  AND ip."deletedAt" IS NULL '
        "  AND ip.status = 'ACTIVE' "
        "  AND family(ip.address) = 4 "
        'ORDER BY ip."createdAt" DESC '
        "LIMIT 1"
    )
    deadline = time.monotonic() + timeout
    while True:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(sql, (boot_mac,))
            row = cur.fetchone()
        if row and row[0]:
            return str(row[0])
        if time.monotonic() >= deadline:
            return None
        time.sleep(interval)


# CLI


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m local.bm_power",
        description="Set PXE boot-source + power a bare-metal box into brokkr-live "
        "(Redfish-first, IPMI fallback), with a wrong-machine guard.",
    )
    parser.add_argument("node", help="Bare-metal node name OR its pxe_mac (colon form)")
    parser.add_argument("expected_uuid", help="Expected bm_device_uuid (SIM_LC_DEVICE_ID) — wrong-machine guard")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--boot-live", action="store_true", help="Set PXE + power-state-aware boot (default)")
    mode.add_argument("--on", action="store_true", help="Set PXE + power on (force)")
    mode.add_argument("--reset", action="store_true", help="Set PXE + reset (force; for a running box)")
    mode.add_argument("--power-cycle", action="store_true", help="Set PXE + power cycle")
    mode.add_argument("--status", action="store_true", help="READ-ONLY: print Redfish PowerState (no PATCH/POST)")
    parser.add_argument(
        "--wait-ip",
        action="store_true",
        help="After power, poll the hub DB until the eth0 IPv4 appears (proof-only; run-plan.ts omits this)",
    )
    parser.add_argument(
        "--timeout-sec",
        type=int,
        default=60,
        metavar="SEC",
        help="Timeout in SECONDS: bounds Redfish per-request + the --wait-ip poll (default: 60)",
    )
    return parser.parse_args(argv)


def _action_from_args(args: argparse.Namespace) -> Action:
    if args.on:
        return "on"
    if args.reset:
        return "reset"
    if args.power_cycle:
        return "powercycle"
    return "auto"  # --boot-live / default: power-state-aware


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    if args.timeout_sec <= 0:
        log.error(f"--timeout-sec must be a positive number of seconds, got {args.timeout_sec}")
        return 2
    # Reject an empty expected_uuid up front: the real cause is an unset SIM_LC_DEVICE_ID, not the
    # confusing "resolves to X, not ''" the wrong-machine guard would otherwise report.
    if not args.expected_uuid.strip():
        log.error("expected_uuid must not be empty (pass SIM_LC_DEVICE_ID)")
        return 2
    try:
        nodes = load_baremetal_nodes()
        node = resolve_bm_node(nodes, args.node)
        creds = load_bmc_creds(node.name)
        # Per-Redfish-request timeout derives from the CLI seconds budget, capped
        # so a single wedged request can't eat the whole budget before a retry.
        per_request = max(10, min(args.timeout_sec, 60))
        # --status returns here: falling through would reach boot_into_live and power the box.
        if args.status:
            log.info(f"{node.name}: PowerState={bm_status(node, creds, args.expected_uuid, timeout=per_request)}")
            return 0
        boot_into_live(node, creds, args.expected_uuid, _action_from_args(args), timeout=per_request)
        if args.wait_ip:
            log.info(
                f"{node.name}: waiting up to {args.timeout_sec}s for eth0 IPv4 to appear (boot MAC {node.pxe_mac})"
            )
            from local.config import get_settings

            ip = _wait_for_data_ip(get_settings().stores.hub_database_url, node.pxe_mac, args.timeout_sec)
            if ip is None:
                log.error(f"{node.name}: no eth0 IPv4 appeared within {args.timeout_sec}s — discovery did not complete")
                return 1
            log.success(f"{node.name}: eth0 IPv4 {ip}")
        return 0
    except (BmPowerError, CommissionError) as e:
        # CommissionError (missing fleet manifest / unreadable bmc-creds.json) would otherwise escape
        # as a traceback — the most likely first-run failure deserves the same named message.
        log.error(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
