#!/usr/bin/env python3
"""ipmi_sim external chassis-control hook → libvirt (virsh): the only seam by which the generic
ipmi_sim BMC moves a node's VM. `boot` is persisted only for the bridge's set-then-verify
round-trip; it never changes real boot order (the spoke's /api/chain decides)."""

import subprocess
import sys
from pathlib import Path

VIRSH, DOMAIN, URI, STATEDIR = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
OP = sys.argv[5] if len(sys.argv) > 5 else ""
ARGS = sys.argv[6:]
BOOTDEV = Path(STATEDIR) / "bootdev"


def virsh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([VIRSH, "-c", URI, *args], capture_output=True, text=True)


def actuate(*args: str) -> bool:
    cp = virsh(*args)
    if cp.returncode != 0:
        sys.stderr.write(f"virsh {' '.join(args)} failed (rc={cp.returncode}): {cp.stderr.strip()}\n")
        return False
    return True


def powered_on() -> bool:
    return virsh("domstate", DOMAIN).stdout.strip() in ("running", "paused")


def do_get(parms: list[str]) -> None:
    for parm in parms:
        if parm == "power":
            print(f"power:{1 if powered_on() else 0}")
        elif parm == "boot":
            dev = BOOTDEV.read_text().strip() if BOOTDEV.exists() else "default"
            print(f"boot:{dev}")


def do_set(pairs: list[str]) -> bool:
    ok = True
    i = 0
    while i < len(pairs):
        parm = pairs[i]
        val = pairs[i + 1] if i + 1 < len(pairs) else ""
        i += 2
        if parm == "power":
            if val == "1" and not powered_on():
                ok = actuate("start", DOMAIN) and ok
            elif val == "0" and powered_on():
                ok = actuate("destroy", DOMAIN) and ok
        elif parm == "reset":
            ok = (actuate("reset", DOMAIN) if powered_on() else actuate("start", DOMAIN)) and ok
        elif parm == "shutdown":
            if powered_on():
                ok = actuate("destroy", DOMAIN) and ok
        elif parm == "boot":
            BOOTDEV.write_text(val)
    return ok


if OP == "get":
    do_get(ARGS)
elif OP == "set":
    if not do_set(ARGS):
        sys.exit(1)
else:
    sys.exit(1)
sys.exit(0)
