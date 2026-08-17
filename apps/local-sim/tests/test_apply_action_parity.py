from __future__ import annotations

import re
from pathlib import Path

from local.apply_plan import NodeAction

_APPS = Path(__file__).resolve().parents[2]
_ROOT = _APPS.parent
CONTRACT = _ROOT / "packages" / "local-lab-contract" / "src" / "schemas" / "fleet.ts"


def _enum_values(contract: Path, name: str) -> list[str]:
    m = re.search(rf"export const {name} = z\s*\.enum\(\[(.*?)\]\)", contract.read_text(), re.S)
    assert m, f"{name} not found in {contract}"
    return re.findall(r"'([^']+)'", m.group(1))


def test_apply_action_parity():
    assert _enum_values(CONTRACT, "ApplyActionSchema") == [a.value for a in NodeAction]
