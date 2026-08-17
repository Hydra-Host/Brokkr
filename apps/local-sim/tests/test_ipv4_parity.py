from __future__ import annotations

import ipaddress
import json
import re
from pathlib import Path

import local.derived as derived
import pytest

_APPS = Path(__file__).resolve().parents[2]
_ROOT = _APPS.parent
_CONTRACT = _ROOT / "packages" / "local-lab-contract" / "src"
_VECTORS = _CONTRACT / "ipv4.vectors.json"
_IPV4_TS = _CONTRACT / "ipv4.ts"


def test_ip_at_offset_parity():
    vectors = json.loads(_VECTORS.read_text())
    for case in vectors["ipAtOffset"]:
        got = str(derived._ip_at_offset(case["cidr"], case["offset"]))
        assert got == case["ip"], f"{case['cidr']} + {case['offset']}: python {got!r} != vector {case['ip']!r}"


def test_node_ip_base_parity():
    m = re.search(r"NODE_IP_BASE\s*=\s*(\d+)", _IPV4_TS.read_text())
    assert m, "NODE_IP_BASE not found in ipv4.ts"
    assert int(m.group(1)) == derived.NODE_IP_BASE


@pytest.mark.parametrize(
    "cidr",
    [
        "010.0.0.0/8",
        "192.168.200.0/1e1",
        "192.168.200.0/24.0",
        "192.168.200.0/0x18",
        "1.2.3.4/+24",
    ],
)
def test_rejection_parity(cidr):
    with pytest.raises(ValueError):
        ipaddress.ip_network(cidr, strict=False)
