from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.requires_host

sys.path.insert(0, str(Path(__file__).resolve().parent))

_skip = pytest.mark.skipif(shutil.which("devenv") is None, reason="devenv not on PATH")

_ONE_MACHINE = """
      fleet.baremetal.iface = "eno1";
      fleet.baremetal.ifaceIp = "10.0.0.5";
      fleet.baremetal.nodes."bm-1" = {
        pxe_mac = "00:00:5e:00:53:a1"; bmc_ip = "10.0.0.20"; bmc_mac = "00:00:5e:00:53:c1";
      };
"""

_NO_VM_NODES = """
      fleet.zones."sim-zone".nodes = {
        cpu-1.enable = false; cpu-2.enable = false; cpu-3.enable = false; cpu-4.enable = false;
      };
"""


@_skip
def test_vm_baseline_identical_overlay_yields_empty_diff():
    from pc_config import flip_diff

    assert flip_diff(None, None) == set()


@_skip
def test_adding_the_first_machine_changes_exactly_spoke_hub_fleet():
    from pc_config import flip_diff

    both_planes = "{ config, ... }: {" + _ONE_MACHINE + "}"
    assert flip_diff(None, both_planes) == {"spoke", "hub-api", "fleet"}


@_skip
def test_tombstoning_every_vm_node_changes_exactly_spoke_hub_fleet():
    from pc_config import flip_diff

    baremetal_only = "{ config, ... }: {" + _NO_VM_NODES + _ONE_MACHINE + "}"
    assert flip_diff(None, baremetal_only) == {"spoke", "hub-api", "fleet"}
