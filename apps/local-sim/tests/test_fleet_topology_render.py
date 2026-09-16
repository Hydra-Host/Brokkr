from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from local.schema import Fleet

pytestmark = pytest.mark.requires_host

_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "fleet-topology"
_REPO_ROOT = Path(__file__).resolve().parents[3]
_EVAL_NIX = _FIXTURES / "eval-fleet.nix"
_GOLDEN_VM = _FIXTURES / "vm-default.fleet.json"

_skip = pytest.mark.skipif(shutil.which("nix") is None, reason="nix not on PATH")


def _render(overlay_nix: str | None = None) -> str:
    overlay = overlay_nix if overlay_nix is not None else "{ }"
    expr = f"(import {_EVAL_NIX} {{ repo = {_REPO_ROOT}; overlay = {overlay}; }}).fleetYaml"
    out = subprocess.run(
        ["nix", "eval", "--impure", "--raw", "--expr", expr],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if out.returncode != 0:
        raise AssertionError(f"nix eval failed:\n{out.stderr}")
    return out.stdout


_BM_MACHINES = """
  fleet.baremetal.iface = "eno1";
  fleet.baremetal.ifaceIp = "10.0.0.5";
  fleet.baremetal.arch = "amd64";
  fleet.baremetal.nodes = {
    "bm-2" = {
      pxe_mac = "00:00:5e:00:53:b4"; bmc_ip = "10.0.0.21"; bmc_mac = "00:00:5e:00:53:c5"; index = 2;
    };
    "bm-1" = {
      pxe_mac = "00:00:5e:00:53:a1"; bmc_ip = "10.0.0.20"; bmc_mac = "00:00:5e:00:53:c1";
      arch = "arm64"; system_id = "1"; network_type = "public"; index = 1;
    };
  };
"""

_NO_VM_NODES = """
  fleet.zones."sim-zone".nodes = {
    cpu-1.enable = false; cpu-2.enable = false; cpu-3.enable = false; cpu-4.enable = false;
  };
"""

_BM_OVERLAY = "{" + _BM_MACHINES + "}"
_BM_ONLY_OVERLAY = "{" + _NO_VM_NODES + _BM_MACHINES + "}"
_EMPTY_OVERLAY = "{" + _NO_VM_NODES + "}"

_VM_NAMES = ["cpu-1", "cpu-2", "cpu-3", "cpu-4"]
_BM_NAMES = ["bm-1", "bm-2"]


@_skip
def test_vm_default_render_is_byte_identical_to_golden():
    rendered = _render()
    golden = _GOLDEN_VM.read_text()
    assert rendered == golden, (
        "fleet-topology.nix vm-mode output drifted from the golden fixture. "
        "If this is an INTENTIONAL topology change, regenerate the fixture. If not, it's a regression."
    )


@_skip
def test_vm_default_render_has_no_mode_or_baremetal_key():
    doc = json.loads(_render())
    assert "mode" not in doc
    assert "baremetal" not in doc


@_skip
def test_baremetal_machines_render_beside_the_vm_nodes_without_a_mode_key():
    doc = json.loads(_render(_BM_OVERLAY))
    assert "mode" not in doc
    assert [n["name"] for n in doc["nodes"]] == _VM_NAMES
    assert [n["name"] for n in doc["baremetal"]["nodes"]] == _BM_NAMES
    assert "bmc" not in doc["baremetal"]
    for n in doc["baremetal"]["nodes"]:
        assert "username" not in n and "password" not in n
        assert "enable" not in n and "index" not in n
    fleet = Fleet.model_validate(doc)
    assert (fleet.has_vm, fleet.has_bm) == (True, True)
    assert [n.name for n in fleet.bm_nodes] == _BM_NAMES
    assert fleet.bm_nodes[0].arch == "arm64"
    assert fleet.bm_nodes[1].arch == "amd64"


@_skip
def test_baremetal_machine_network_type_renders_only_when_set():
    doc = json.loads(_render(_BM_OVERLAY))
    by_name = {n["name"]: n for n in doc["baremetal"]["nodes"]}
    assert by_name["bm-1"]["network_type"] == "public"
    assert "network_type" not in by_name["bm-2"]
    fleet = Fleet.model_validate(doc)
    assert fleet.bm_nodes[0].network_type == "public"
    assert fleet.bm_nodes[1].network_type is None


@_skip
def test_tombstoning_every_vm_node_renders_an_empty_roster_beside_the_machines():
    doc = json.loads(_render(_BM_ONLY_OVERLAY))
    assert "mode" not in doc
    assert doc["nodes"] == []
    assert [n["name"] for n in doc["baremetal"]["nodes"]] == _BM_NAMES
    fleet = Fleet.model_validate(doc)
    assert (fleet.has_vm, fleet.has_bm) == (False, True)


@_skip
def test_tombstoning_every_node_without_a_machine_fails_evaluation():
    with pytest.raises(AssertionError, match="no enabled node in either plane"):
        _render(_EMPTY_OVERLAY)


@_skip
def test_baremetal_render_prunes_null_optionals():
    doc = json.loads(_render(_BM_OVERLAY))
    by_name = {n["name"]: n for n in doc["baremetal"]["nodes"]}
    assert "arch" not in by_name["bm-2"]
    assert "system_id" not in by_name["bm-2"]
    assert by_name["bm-1"]["arch"] == "arm64"
    assert by_name["bm-1"]["system_id"] == "1"
