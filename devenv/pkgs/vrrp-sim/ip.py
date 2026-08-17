#!/usr/bin/env python3
"""Sim-only `ip` shim for local VRRP VIP failover e2e — fakes addr add/del/show against a
per-bridge JSON state file (keyed VRRP_SIM_STATE_FILE / VRRP_SIM_STATE_DIR/<BRIDGE_HOSTNAME>.json,
so a non-leader doesn't see the leader's VIP); unhandled verbs pass through to $VRRP_SIM_REAL_IP."""
import json
import os
import sys


def state_path() -> str:
    explicit = os.environ.get("VRRP_SIM_STATE_FILE", "").strip()
    if explicit:
        return explicit
    state_dir = os.environ.get("VRRP_SIM_STATE_DIR", "/tmp/brokkr-dev/vrrp-sim").strip()
    host = os.environ.get("BRIDGE_HOSTNAME", "default").strip() or "default"
    return os.path.join(state_dir, f"{host}.json")


def load(path: str) -> list:
    try:
        with open(path, "r") as fh:
            data = json.load(fh)
            return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save(path: str, entries: list) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as fh:
        json.dump(entries, fh)


def fail(msg: str) -> "int":
    sys.stderr.write(f"RTNETLINK answers: {msg}\n")
    return 2


def split_cidr(cidr: str) -> "tuple[str, int]":
    if "/" in cidr:
        host, mask = cidr.split("/", 1)
        return host, int(mask)
    return cidr, 32


def positional(args: "list[str]") -> "list[str]":
    return [a for a in args if not a.startswith("-")]


def value_after(args: "list[str]", key: str) -> "str | None":
    if key in args:
        i = args.index(key)
        if i + 1 < len(args):
            return args[i + 1]
    return None


def passthrough(args: "list[str]") -> int:
    real = os.environ.get("VRRP_SIM_REAL_IP", "").strip()
    if real and os.path.exists(real):
        os.execv(real, [real] + args)
    if "-j" in args or "-json" in args:
        sys.stdout.write("[]\n")
    return 0


def emit_show(entries: list) -> int:
    by_iface: "dict[str, list]" = {}
    for e in entries:
        by_iface.setdefault(e["iface"], []).append(
            {"local": e["local"], "prefixlen": e["prefixlen"], "label": e["label"]}
        )
    out = [{"ifname": iface, "addr_info": infos} for iface, infos in by_iface.items()]
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


def main() -> int:
    args = sys.argv[1:]
    pos = positional(args)
    obj = pos[0] if pos else ""
    verb = pos[1] if len(pos) > 1 else ""

    if obj not in ("addr", "address", "a"):
        return passthrough(args)

    path = state_path()
    entries = load(path)

    if verb == "show":
        return emit_show(entries)

    if verb in ("add", "del"):
        cidr = pos[2] if len(pos) > 2 else ""
        iface = value_after(args, "dev") or ""
        local, prefixlen = split_cidr(cidr)
        idx = next(
            (i for i, e in enumerate(entries)
             if e["local"] == local and e["prefixlen"] == prefixlen and e["iface"] == iface),
            None,
        )
        if verb == "add":
            if idx is not None:
                return fail("File exists")
            label = value_after(args, "label") or ""
            entries.append({"local": local, "prefixlen": prefixlen, "iface": iface, "label": label})
            save(path, entries)
            return 0
        # del
        if idx is None:
            return fail("Cannot assign requested address")
        entries.pop(idx)
        save(path, entries)
        return 0

    return passthrough(args)


if __name__ == "__main__":
    sys.exit(main())
