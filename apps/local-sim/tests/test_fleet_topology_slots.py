import json
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.requires_host

ROOT = Path(__file__).resolve().parents[3]
LOCAL_NIX = ROOT / "devenv.local.nix"


@pytest.fixture
def fleet_for():
    def _render(slot: int, nodes: int | None = None) -> dict:
        count = f"stack.fleetNodeCount = {nodes};" if nodes else ""
        backup = LOCAL_NIX.read_text() if LOCAL_NIX.exists() else None
        LOCAL_NIX.write_text(f"{{ stack.slot = {slot}; {count} }}\n")
        try:
            out = subprocess.run(
                ["devenv", "eval", "fleet"],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=True,
            )
            return json.loads(out.stdout)["fleet"]
        finally:
            if backup is None:
                LOCAL_NIX.unlink(missing_ok=True)
            else:
                LOCAL_NIX.write_text(backup)

    return _render


def test_slot0_fleet_unchanged(fleet_for):
    f = fleet_for(0)
    assert f["network"]["cidr"] == "192.168.200.0/24"
    assert f["network"]["bmc_cidr"] == "192.168.105.0/24"
    assert sorted(f["zones"]["sim-zone"]["nodes"]) == ["cpu-1", "cpu-2", "cpu-3", "cpu-4"]
    assert f["zones"]["sim-zone"]["nodes"]["cpu-1"]["ipmi_mac"] == "52:54:00:bc:00:01"
    assert "console_port" not in f["zones"]["sim-zone"]["nodes"]["cpu-1"]


def test_slot2_fleet(fleet_for):
    f = fleet_for(2)
    assert f["network"]["cidr"] == "192.168.202.0/24"
    assert f["network"]["bmc_cidr"] == "192.168.107.0/24"
    nodes = f["zones"]["sim-zone"]["nodes"]
    assert list(nodes) == ["s2-cpu-1"]
    assert nodes["s2-cpu-1"]["ipmi_mac"] == "52:54:00:bc:02:01"
    assert nodes["s2-cpu-1"]["data_mac"] == "52:54:00:da:02:01"
    assert nodes["s2-cpu-1"]["console_port"] == 21060


def test_slot10_mac_hex_is_lowercase(fleet_for):
    f = fleet_for(10)
    node = f["zones"]["sim-zone"]["nodes"]["s10-cpu-1"]
    assert node["ipmi_mac"] == f"52:54:00:bc:{10:02x}:01"


def test_fleet_node_count_override(fleet_for):
    f = fleet_for(3, nodes=4)
    nodes = f["zones"]["sim-zone"]["nodes"]
    assert sorted(nodes) == ["s3-cpu-1", "s3-cpu-2", "s3-cpu-3", "s3-cpu-4"]
    assert nodes["s3-cpu-4"]["ipmi_mac"] == "52:54:00:bc:03:04"
    assert nodes["s3-cpu-4"]["console_port"] == 21563
