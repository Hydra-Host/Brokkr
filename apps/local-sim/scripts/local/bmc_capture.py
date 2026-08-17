"""Capture a real (or sim) BMC into a per-server mock: walk the Redfish tree from ``/redfish/v1``
into a DMTF mockup dir, then sweep the IPMI commands the bridge's monitoring reads. Needs a
reachable target (real BMC over VPN, or the sim's sushy/ipmi_sim)."""

from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# IPMI commands the bridge monitoring reads (bridge/config/monitoring.py allowlist).
IPMI_SWEEP = [
    ["mc", "info"],
    ["chassis", "status"],
    ["sensor", "list"],
    ["sdr", "list"],
    ["sdr", "elist"],
    ["sel", "list"],
    ["fru", "print"],
    ["dcmi", "power", "reading"],
    ["lan", "print"],
    ["user", "list"],
    ["channel", "info", "1"],
]


def _redfish_get(url: str, auth_header: str) -> dict | None:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # sim/BMC self-signed
    req = urllib.request.Request(url, headers={"Authorization": auth_header, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  [redfish] {url} → HTTP {e.code}", file=sys.stderr)
    except Exception as e:
        print(f"  [redfish] {url} → {e}", file=sys.stderr)
    return None


def _odata_ids(doc: object) -> list[str]:
    """Every ``@odata.id`` string reachable in the document (the link graph)."""
    out: list[str] = []
    if isinstance(doc, dict):
        for k, v in doc.items():
            if k == "@odata.id" and isinstance(v, str):
                out.append(v)
            else:
                out.extend(_odata_ids(v))
    elif isinstance(doc, list):
        for v in doc:
            out.extend(_odata_ids(v))
    return out


def capture_redfish(base: str, auth_header: str, out: Path, trim: bool) -> int:
    """BFS the Redfish link graph from /redfish/v1; write each resource as a mockup index.json
    under out/redfish/<path>/. Returns resources captured."""
    seen: set[str] = set()
    queue = ["/redfish/v1"]
    count = 0
    while queue:
        path = queue.pop(0)
        if path in seen:
            continue
        seen.add(path)
        if trim and any(seg in path for seg in ("LogServices", "/Logs", "/Entries")):
            continue
        # a malicious/buggy BMC can return an @odata.id with '..' segments that escape out;
        # reject before issuing the request so the escaping path never goes over the wire
        dest = out / path.lstrip("/")
        if not dest.resolve().is_relative_to(out.resolve()):
            print(f"  [redfish] {path} escapes {out}, skipped", file=sys.stderr)
            continue
        doc = _redfish_get(base + path, auth_header)
        if doc is None:
            continue
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "index.json").write_text(json.dumps(doc, indent=2))
        count += 1
        for ref in _odata_ids(doc):
            if ref.startswith("/redfish/") and ref not in seen:
                queue.append(ref)
    return count


def capture_ipmi(host: str, user: str, password: str, port: int, out: Path) -> int:
    """Run the bridge's monitoring IPMI commands over LAN; store each output."""
    out.mkdir(parents=True, exist_ok=True)
    ok = 0
    # -E reads the password from IPMI_PASSWORD in the child env, keeping it off argv (ps-visible)
    env = {**os.environ, "IPMI_PASSWORD": password}
    for cmd in IPMI_SWEEP:
        argv = ["ipmitool", "-I", "lanplus", "-H", host, "-p", str(port), "-U", user, "-E", *cmd]
        name = "_".join(cmd).replace("/", "_")
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=30, env=env)
            (out / f"{name}.txt").write_text(r.stdout + (f"\n[stderr]\n{r.stderr}" if r.returncode else ""))
            if r.returncode == 0:
                ok += 1
        except Exception as e:
            (out / f"{name}.txt").write_text(f"[error] {e}")
    return ok


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--port", type=int, default=8443, help="Redfish port")
    ap.add_argument("--scheme", default="https", choices=["http", "https"])
    ap.add_argument("--ipmi-port", type=int, default=623)
    ap.add_argument("--no-ipmi", action="store_true")
    ap.add_argument("--trim", action="store_true", help="skip LogServices/Entries")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)

    from local.config import REPO

    key = args.host.replace(":", "_").replace(".", "-")
    out = Path(args.out) if args.out else (REPO / "mocks" / key)
    out.mkdir(parents=True, exist_ok=True)

    auth = "Basic " + base64.b64encode(f"{args.user}:{args.password}".encode()).decode()
    base = f"{args.scheme}://{args.host}:{args.port}"
    print(f"[capture] redfish ← {base}/redfish/v1 → {out}/redfish")
    n = capture_redfish(base, auth, out, args.trim)
    print(f"[capture] redfish: {n} resources")

    ipmi_ok = 0
    if not args.no_ipmi:
        print(f"[capture] ipmi ← {args.host}:{args.ipmi_port} ({len(IPMI_SWEEP)} commands)")
        ipmi_ok = capture_ipmi(args.host, args.user, args.password, args.ipmi_port, out / "ipmi")
        print(f"[capture] ipmi: {ipmi_ok}/{len(IPMI_SWEEP)} commands ok")

    (out / "mock.json").write_text(
        json.dumps(
            {
                "host": args.host,
                "redfish_port": args.port,
                "scheme": args.scheme,
                "redfish_resources": n,
                "ipmi_ok": ipmi_ok,
                "trimmed": args.trim,
            },
            indent=2,
        )
    )
    print(f"[capture] wrote {out}/mock.json")


if __name__ == "__main__":
    main(sys.argv[1:])
