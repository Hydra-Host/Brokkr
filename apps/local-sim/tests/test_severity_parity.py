from __future__ import annotations

import re
import typing
from pathlib import Path

from local.applied import Severity

_APPS = Path(__file__).resolve().parents[2]
_ROOT = _APPS.parent
CONTRACT = _ROOT / "packages" / "local-lab-contract" / "src" / "schemas" / "fleet.ts"


def _enum_values(contract: Path, name: str) -> list[str]:
    m = re.search(rf"export const {name} = z\s*\.enum\(\[(.*?)\]\)", contract.read_text(), re.S)
    if m:
        return re.findall(r"'([^']+)'", m.group(1))
    m = re.search(rf"{name}\s*:\s*\n?\s*z\s*\.enum\(\[(.*?)\]\)", contract.read_text(), re.S)
    assert m, f"{name} not found in {contract}"
    return re.findall(r"'([^']+)'", m.group(1))


def _severity_members() -> list[str]:
    args = typing.get_args(Severity)
    return list(args)


def test_severity_parity():
    ts_values = _enum_values(CONTRACT, "severity")
    py_values = _severity_members()
    assert ts_values == py_values, f"Severity mismatch: TS contract has {ts_values!r}, applied.py has {py_values!r}"
