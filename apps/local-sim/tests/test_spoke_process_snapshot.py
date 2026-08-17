from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

pytestmark = pytest.mark.requires_host

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "process-compose" / "spoke.process.json"

_skip = pytest.mark.skipif(shutil.which("devenv") is None, reason="devenv not on PATH")


@_skip
def test_spoke_process_definition_matches_snapshot():
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pc_config import render_under_overlay, snapshot_process

    # Render WITHOUT stack.local.nix — the frozen snapshot is the committed
    # (vm-mode) topology; a host's fleet-mode overlay must not leak in.
    cfg = render_under_overlay(None)
    actual = snapshot_process(cfg, "spoke")
    expected = json.loads(_FIXTURE.read_text())
    assert actual == expected, (
        "spoke process definition drifted from the frozen snapshot.\n"
        "If this is the intended exec/env change, regenerate the fixture:\n"
        "  python -c \"import sys,json; sys.path.insert(0,'tests'); "
        "from pc_config import render_under_overlay,snapshot_process as s; "
        "print(json.dumps(s(render_under_overlay(None),'spoke'),indent=2,sort_keys=True))\" "
        "> tests/fixtures/process-compose/spoke.process.json"
    )
