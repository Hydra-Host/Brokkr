"""Enum-driven bring-up progress — a small atomic JSON file the control center reads to show fleet
bring-up status. The engine (local.fleet) is the sole writer; operator-progress only, NOT a control channel."""

from __future__ import annotations

import json
import os
import tempfile
import time
from enum import Enum
from pathlib import Path
from typing import Any

from local.config import get_settings


class Phase(str, Enum):
    IDLE = "idle"
    INIT = "init"
    UP = "up"
    SUPERVISING = "supervising"
    DOWN = "down"


class Step(str, Enum):
    BUILD_LIVE_IMG = "build-live-img"
    BUILD_AGENT_IMG = "build-agent-img"
    BUILD_GRUB = "build-grub"
    PREFETCH = "prefetch"
    BUILD_IPXE = "build-ipxe"
    RENDER = "render"
    DAEMONS = "daemons"
    POWER_ON = "power-on"
    READY = "ready"
    TEARING_DOWN = "tearing-down"
    IDLE = "idle"


BRINGUP_SEQUENCE: tuple[Step, ...] = (
    Step.BUILD_LIVE_IMG,
    Step.BUILD_AGENT_IMG,
    Step.BUILD_GRUB,
    Step.PREFETCH,
    Step.BUILD_IPXE,
    Step.RENDER,
    Step.DAEMONS,
    Step.POWER_ON,
    Step.READY,
)

STEP_PHASE: dict[Step, Phase] = {
    Step.BUILD_LIVE_IMG: Phase.INIT,
    Step.BUILD_AGENT_IMG: Phase.INIT,
    Step.BUILD_GRUB: Phase.INIT,
    Step.PREFETCH: Phase.INIT,
    Step.BUILD_IPXE: Phase.INIT,
    Step.RENDER: Phase.UP,
    Step.DAEMONS: Phase.UP,
    Step.POWER_ON: Phase.UP,
    Step.READY: Phase.UP,
    Step.TEARING_DOWN: Phase.DOWN,
    Step.IDLE: Phase.IDLE,
}

STEP_LABEL: dict[Step, str] = {
    Step.BUILD_LIVE_IMG: "building brokkr-live.img",
    Step.BUILD_AGENT_IMG: "building bridge-agent.img",
    Step.BUILD_GRUB: "building grub boot binaries",
    Step.PREFETCH: "warming discovery images",
    Step.BUILD_IPXE: "building per-VM iPXE binaries",
    Step.RENDER: "rendering fleet config",
    Step.DAEMONS: "starting network + IPMI daemons",
    Step.POWER_ON: "defining + powering on VMs",
    Step.READY: "fleet up",
    Step.TEARING_DOWN: "tearing down",
    Step.IDLE: "fleet down",
}


def step_ordinal(step: Step) -> int:
    return BRINGUP_SEQUENCE.index(step) if step in BRINGUP_SEQUENCE else -1


def progress_path() -> Path:
    return get_settings().state.run_dir / "fleet-progress.json"


def read() -> dict[str, Any] | None:
    try:
        return json.loads(progress_path().read_text())
    except (FileNotFoundError, ValueError):
        return None


def clear() -> None:
    progress_path().unlink(missing_ok=True)


def set(  # deliberate module-API verb (shadows the builtin)
    step: Step,
    *,
    label: str | None = None,
    node: str | None = None,
    index: int = 0,
    total: int = 0,
    error: str | None = None,
    started: bool = False,
) -> None:
    """Write the current bring-up step (phase/label/ordinal derive from the ``Step`` enum). ``started=True``
    stamps ``startedAt``. Best-effort: writes are swallowed so progress reporting never breaks a bring-up."""
    prev = read() or {}
    now = time.time()
    rec = {
        "phase": STEP_PHASE[step].value,
        "step": step.value,
        "label": label if label is not None else STEP_LABEL[step],
        "node": node,
        "index": index,
        "total": total,
        "stepOrdinal": step_ordinal(step),
        "stepCount": len(BRINGUP_SEQUENCE),
        "startedAt": now if started or "startedAt" not in prev else prev["startedAt"],
        "updatedAt": now,
        "error": error,
    }
    _write(rec)


def error(message: str) -> None:
    """Record a failure on the CURRENT step without advancing it (so the UI shows WHERE it failed).
    Best-effort like set(); a missing prior record falls back to a terminal IDLE/DOWN shell."""
    rec = read() or {
        "phase": Phase.DOWN.value,
        "step": Step.IDLE.value,
        "label": STEP_LABEL[Step.IDLE],
        "node": None,
        "index": 0,
        "total": 0,
        "stepOrdinal": step_ordinal(Step.IDLE),
        "stepCount": len(BRINGUP_SEQUENCE),
        "startedAt": time.time(),
    }
    rec["error"] = message
    rec["updatedAt"] = time.time()
    _write(rec)


def _write(rec: dict[str, Any]) -> None:
    """Atomic temp-file + rename write of the progress record. Swallowed on any OS error — progress
    reporting must never break a bring-up."""
    path = progress_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".fleet-progress.", suffix=".json")
    except OSError:
        return
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(rec, fh)
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
