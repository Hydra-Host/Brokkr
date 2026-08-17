from __future__ import annotations

import re
from pathlib import Path

from local.progress import Phase, Step

_APPS = Path(__file__).resolve().parents[2]
_ROOT = _APPS.parent
CONTRACT = _ROOT / "packages" / "local-lab-contract" / "src" / "schemas" / "stack.ts"
FLEET_HEALTH = _APPS / "local-lab" / "src" / "services" / "fleet-health.ts"


def _enum_values(contract: Path, name: str) -> list[str]:
    m = re.search(rf"export const {name} = z\s*\.enum\(\[(.*?)\]\)", contract.read_text(), re.S)
    assert m, f"{name} not found in {contract}"
    return re.findall(r"'([^']+)'", m.group(1))


def test_step_enum_parity():
    assert _enum_values(CONTRACT, "BringupStepSchema") == [s.value for s in Step]


def test_phase_enum_parity():
    assert _enum_values(CONTRACT, "BringupPhaseSchema") == [p.value for p in Phase]


def test_fleet_health_has_no_duplicate_unions():
    src = FLEET_HEALTH.read_text()
    for name in ("BringupStep", "BringupPhase"):
        assert not re.search(rf"export type {name} =\s*'", src), (
            f"fleet-health.ts redefines {name} as a literal union — import it from the contract instead"
        )
