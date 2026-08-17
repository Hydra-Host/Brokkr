"""Print a device's hub-computed, eligibility-filtered OS-customization layer tree as JSON.

Eligibility is hub-sourced (nothing recomputed here) and depends on the discovered
``gpuModel`` — no GPU → only hardware-agnostic layers; GPU driver/CUDA groups appear once one is.
Usage: ``python -m local.layer_catalog <node-name-or-index>``  → JSON on stdout.
"""

from __future__ import annotations

import json
import sys

from local.derived import sim_device_uuid
from local.fleet import load_fleet, resolve_index
from local.hub_client import HubClient, HubUnreachable


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        raise SystemExit("usage: python -m local.layer_catalog <node-name-or-index>")
    fleet = load_fleet()
    idx = resolve_index(argv[0], fleet)
    node = fleet.nodes[idx]
    device_id = sim_device_uuid(idx)

    client = HubClient()
    try:
        client.sign_in()
        code, body = client.get_server(device_id)
    except HubUnreachable as e:
        # Clean one-line message (no traceback) — the control center relays this
        # straight to the layer picker.
        raise SystemExit(str(e)) from None
    if code != 200 or not body:
        raise SystemExit(f"admin get_server({device_id}) failed ({code}): {body}")

    # lifecycleStatus comes back as {value, label} on the servers record.
    lifecycle = body.get("lifecycleStatus") or body.get("status")
    if isinstance(lifecycle, dict):
        lifecycle = lifecycle.get("value")

    # GPU model lives at specs.gpu.model, not a top-level gpuModel field.
    gpu_model = ((body.get("specs") or {}).get("gpu") or {}).get("model")

    out = {
        "node": node.name,
        "deviceId": device_id,
        "gpuModel": gpu_model,
        "lifecycleStatus": lifecycle,
        "baseLayers": body.get("availableBaseLayers") or [],
        "componentsByBase": body.get("availableComponentLayersByBase") or {},
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
