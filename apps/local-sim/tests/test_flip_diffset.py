from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.requires_host

sys.path.insert(0, str(Path(__file__).resolve().parent))

_skip = pytest.mark.skipif(shutil.which("devenv") is None, reason="devenv not on PATH")


@_skip
def test_vm_baseline_identical_overlay_yields_empty_diff():
    from pc_config import flip_diff

    assert flip_diff(None, None) == set()


@_skip
def test_flip_vm_to_baremetal_changes_exactly_spoke_hub_fleet():
    from pc_config import flip_diff

    bm_overlay = """
    { config, ... }: {
      fleet.mode = "baremetal";
      fleet.baremetal.iface = "eno1";
      fleet.baremetal.ifaceIp = "10.0.0.5";
      fleet.baremetal.nodes."bm-1" = {
        pxe_mac = "00:00:5e:00:53:a1"; bmc_ip = "10.0.0.20"; bmc_mac = "00:00:5e:00:53:c1";
      };
    }
    """
    assert flip_diff(None, bm_overlay) == {"spoke", "hub-api", "fleet"}
