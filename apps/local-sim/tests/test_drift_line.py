import time

from local import applied
from local.schema import Fleet

FLEET = {
    "network": {"name": "n", "cidr": "192.168.200.0/24", "domain": "d", "bmc_cidr": "192.168.105.0/24"},
    "defaults": {"cpus": 2, "memory_mb": 4096, "disk_gb": 40, "arch": "x86_64"},
    "nodes": [{"name": "cpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}],
}


def test_drift_line_reports_pending_with_apply_hint():
    f = Fleet.model_validate(FLEET)
    # an applied manifest with no nodes → desired fleet has 1 added node → pending changes branch
    prev = applied.AppliedManifest(
        digest="sha256:old",
        applied_at=time.time() - 60,
        source="fleet.yml",
        network={"cidr": f.network.cidr, "bmc_cidr": f.network.bmc_cidr},
        nodes=[],
    )
    line = applied.drift_summary_line(applied.diff(f, prev))
    assert "pending fleet changes" in line
    assert "task sim:fleet:apply" in line


def test_drift_line_counts_network_only_drift():
    # network/CIDR drift with zero per-node changes must still report a pending change — the
    # control-center banner counts it, and this summary line must agree (not read "0 pending").
    d = applied.FleetDiff(
        in_sync=False,
        severity="needs-full-rebuild",
        desired_digest="sha256:new",
        applied_digest="sha256:old",
        applied_at=time.time() - 60,
        summary=applied.DriftSummary(added=0, removed=0, changed=0, unchanged=1),
        nodes=applied.DriftNodes(),
        network=applied.NetworkDrift(changed=True, fields=["cidr"]),
    )
    line = applied.drift_summary_line(d)
    assert "1 pending fleet changes" in line
    assert "network" in line
    assert "0 pending" not in line
