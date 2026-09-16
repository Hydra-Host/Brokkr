from __future__ import annotations

import types

import pytest
from local import verify, verify_baremetal
from local.applied import AppliedBmNode, AppliedManifest, AppliedNode

_CANONICAL = "11111111-1111-1111-1111-111111111111"
_OTHER = "22222222-2222-2222-2222-222222222222"


def _bm_node(name: str = "bm-1") -> AppliedBmNode:
    return AppliedBmNode(
        name=name,
        zone="z",
        pxe_mac="00:00:5e:00:53:a1",
        bmc_ip="10.0.0.20",
        bmc_mac="00:00:5e:00:53:b1",
        arch="amd64",
        system_id=None,
        fields={},
    )


def _vm_node(name: str = "gpu-1", index: int = 0) -> AppliedNode:
    return AppliedNode(
        name=name, zone="z", index=index, ip=f"10.0.1.{10 + index}", bmc_ip=f"10.0.0.{30 + index}", fields={}
    )


def _manifest(nodes: list[AppliedBmNode], *, vm_nodes: list[AppliedNode] | None = None) -> AppliedManifest:
    return AppliedManifest(
        digest="sha256:x",
        applied_at=1.0,
        source="/x",
        network={"cidr": "10.0.0.0/24", "bmc_cidr": "10.0.0.0/24", "dhcp": True},
        nodes=vm_nodes or [],
        bm_nodes=nodes,
    )


def _snapshot(**overrides) -> verify_baremetal.BareMetalLiveState:
    node = verify_baremetal.BareMetalNodeLiveState(
        name="bm-1",
        power_state="On",
        bmc_auth_ok=True,
        pxe_mac_device_id=_CANONICAL,
        bmc_mac_device_id=_CANONICAL,
    )
    for key, value in overrides.items():
        setattr(node, key, value)
    return verify_baremetal.BareMetalLiveState(nodes=[node])


def _vm_live_node(name: str = "gpu-1", **overrides) -> verify.NodeLiveState:
    node = verify.NodeLiveState(name=name, domstate="running", ipmi_sim=True, sushy=True, lo_alias_present=True)
    for key, value in overrides.items():
        setattr(node, key, value)
    return node


def _kinds(findings: list[verify.VerifyFinding]) -> list[verify.FindingKind]:
    return [f.kind for f in findings]


def _fleet_node(name: str) -> types.SimpleNamespace:
    return types.SimpleNamespace(name=name, bmc_ip="10.0.0.20")


def _collect_and_classify_one_box(monkeypatch) -> list[verify.VerifyFinding]:
    from local import commission_baremetal

    monkeypatch.setattr(commission_baremetal, "load_baremetal_nodes", lambda: [_fleet_node("bm-1")])
    monkeypatch.setattr(verify_baremetal, "_hub_identities", lambda manifest: {"bm-1": (_CANONICAL, _CANONICAL)})
    manifest = _manifest([_bm_node()])
    return verify_baremetal.classify_baremetal(manifest, verify_baremetal.collect_baremetal_live_state(manifest))


def test_reachable_known_box_yields_no_findings():
    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), _snapshot())

    assert findings == []


def test_uncollected_power_state_is_bmc_unreachable():
    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), _snapshot(power_state=None))

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert findings[0].node == "bm-1"
    assert findings[0].healable is False


def test_rejected_credentials_are_bmc_auth_failed():
    snapshot = _snapshot(bmc_auth_ok=False, power_state=None)

    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), snapshot)

    assert _kinds(findings) == [verify.FindingKind.BMC_AUTH_FAILED]
    assert findings[0].healable is False


def test_box_no_hub_device_carries_is_no_hub_device():
    snapshot = _snapshot(pxe_mac_device_id=None, bmc_mac_device_id=None)

    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), snapshot)

    assert _kinds(findings) == [verify.FindingKind.NO_HUB_DEVICE]


def test_disagreeing_addresses_are_identity_split():
    snapshot = _snapshot(bmc_mac_device_id=_OTHER)

    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), snapshot)

    assert _kinds(findings) == [verify.FindingKind.IDENTITY_SPLIT]


def test_unreadable_fleet_config_is_named_instead_of_blaming_the_hardware():
    findings = verify_baremetal.classify_baremetal(
        _manifest([_bm_node()]),
        _snapshot(power_state=None, bmc_auth_ok=None, probe_skipped="fleet.yml could not be read (bad yaml)"),
    )

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert "fleet.yml could not be read" in findings[0].detail
    assert "cabling" not in findings[0].detail


def test_box_the_fleet_no_longer_names_is_reported_as_unprobed():
    findings = verify_baremetal.classify_baremetal(
        _manifest([_bm_node()]),
        _snapshot(power_state=None, bmc_auth_ok=None, probe_skipped="fleet.yml no longer names this box"),
    )

    assert "no longer names this box" in findings[0].detail
    assert "cabling" not in findings[0].detail


def test_a_probed_box_that_stayed_silent_still_blames_the_box():
    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), _snapshot(power_state=None))

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert "cabling" in findings[0].detail


def test_unloadable_bmc_credentials_are_named_instead_of_blaming_the_box(monkeypatch):
    from local import commission_baremetal

    def no_creds(node_name):
        raise commission_baremetal.CommissionError("no entry for bm-1")

    monkeypatch.setattr(commission_baremetal, "load_bmc_creds", no_creds)

    findings = _collect_and_classify_one_box(monkeypatch)

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert "was not probed" in findings[0].detail
    assert "credentials" in findings[0].detail
    assert "no entry for bm-1" in findings[0].detail
    assert "cabling" not in findings[0].detail


def test_a_probe_that_fails_on_the_wire_still_blames_the_box(monkeypatch):
    from local import bm_power, commission_baremetal

    def refused(*args):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(
        commission_baremetal, "load_bmc_creds", lambda node_name: commission_baremetal.BmcCreds("admin", "admin")
    )
    monkeypatch.setattr(bm_power, "_resolve_system_path", refused)

    findings = _collect_and_classify_one_box(monkeypatch)

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert "cabling" in findings[0].detail


def test_collector_marks_every_box_unprobed_when_the_fleet_config_fails_to_load(monkeypatch):
    from local import commission_baremetal

    def boom():
        raise commission_baremetal.CommissionError("bad yaml at line 3")

    monkeypatch.setattr(commission_baremetal, "load_baremetal_nodes", boom)
    monkeypatch.setattr(verify_baremetal, "_hub_identities", lambda manifest: {})

    live = verify_baremetal.collect_baremetal_live_state(_manifest([_bm_node("bm-1"), _bm_node("bm-2")]))

    assert [n.probe_skipped for n in live.nodes] == [
        "fleet.yml could not be read (bad yaml at line 3)",
        "fleet.yml could not be read (bad yaml at line 3)",
    ]


def test_finding_quotes_the_address_the_probe_dialled_not_the_applied_one():
    findings = verify_baremetal.classify_baremetal(
        _manifest([_bm_node()]),
        _snapshot(power_state=None, probed_address="10.0.0.99"),
    )

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert "10.0.0.99" in findings[0].detail
    assert "10.0.0.20" not in findings[0].detail


def test_finding_falls_back_to_the_applied_address_when_nothing_was_dialled():
    findings = verify_baremetal.classify_baremetal(_manifest([_bm_node()]), _snapshot(power_state=None))

    assert _kinds(findings) == [verify.FindingKind.BMC_UNREACHABLE]
    assert "10.0.0.20" in findings[0].detail


def test_probe_budget_stops_probing_and_names_why(monkeypatch):
    from local import commission_baremetal

    monkeypatch.setattr(
        commission_baremetal, "load_baremetal_nodes", lambda: [_fleet_node("bm-1"), _fleet_node("bm-2")]
    )
    monkeypatch.setattr(verify_baremetal, "_hub_identities", lambda manifest: {})
    probed: list[str] = []
    monkeypatch.setattr(verify_baremetal, "_probe_bmc", lambda n: (probed.append(n.name), ("On", True, None))[1])
    clock = iter([0.0, 0.0, 6.0])
    monkeypatch.setattr(verify_baremetal, "monotonic", lambda: next(clock))

    live = verify_baremetal.collect_baremetal_live_state(
        _manifest([_bm_node("bm-1"), _bm_node("bm-2")]), probe_budget_seconds=5.0
    )

    assert probed == ["bm-1"]
    assert live.nodes[1].probe_skipped is not None
    assert "the 5s bmc probe budget ran out" in live.nodes[1].probe_skipped
    assert live.nodes[1].power_state is None


def test_build_verify_report_surfaces_baremetal_findings_end_to_end():
    manifest = _manifest([_bm_node()])
    live = _snapshot(power_state=None, bmc_auth_ok=None)

    report = verify.build_verify_report(manifest, None, "linux", bm_live=live)

    assert report.planes == verify.VerifyPlanes(vm=False, baremetal=True)
    assert report.status == verify.VerifyStatus.FINDINGS
    assert verify.FindingKind.BMC_UNREACHABLE in [f.kind for f in report.findings]


def test_manifest_carrying_both_rosters_classifies_both_planes_and_sums_the_summary():
    manifest = _manifest([_bm_node("bm-1"), _bm_node("bm-2")], vm_nodes=[_vm_node("gpu-1"), _vm_node("gpu-2", 1)])
    vm_live = verify.LiveState(nodes=[_vm_live_node("gpu-1"), _vm_live_node("gpu-2", ipmi_sim=False)])
    bm_live = verify_baremetal.BareMetalLiveState(
        nodes=[_snapshot().nodes[0], _snapshot(name="bm-2", power_state=None).nodes[0]]
    )

    report = verify.build_verify_report(manifest, vm_live, "linux", bm_live=bm_live)

    assert report.planes == verify.VerifyPlanes(vm=True, baremetal=True)
    assert report.status == verify.VerifyStatus.FINDINGS
    assert _kinds(report.findings) == [verify.FindingKind.IPMI_SIM_DOWN, verify.FindingKind.BMC_UNREACHABLE]
    assert report.summary == verify.VerifySummary(checked=4, ok=2, findings=2)


@pytest.mark.parametrize(("vm_ipmi_sim", "bm_power_state"), [(False, "On"), (True, None)])
def test_one_flagged_plane_is_enough_for_findings(vm_ipmi_sim, bm_power_state):
    manifest = _manifest([_bm_node()], vm_nodes=[_vm_node()])
    vm_live = verify.LiveState(nodes=[_vm_live_node(ipmi_sim=vm_ipmi_sim)])

    report = verify.build_verify_report(manifest, vm_live, "linux", bm_live=_snapshot(power_state=bm_power_state))

    assert report.status == verify.VerifyStatus.FINDINGS
    assert report.summary == verify.VerifySummary(checked=2, ok=1, findings=1)


def test_both_rosters_without_findings_are_healthy():
    manifest = _manifest([_bm_node()], vm_nodes=[_vm_node()])

    report = verify.build_verify_report(
        manifest, verify.LiveState(nodes=[_vm_live_node()]), "linux", bm_live=_snapshot()
    )

    assert report.status == verify.VerifyStatus.HEALTHY
    assert report.summary == verify.VerifySummary(checked=2, ok=2, findings=0)


def _record_collectors(monkeypatch) -> list[str]:
    collected: list[str] = []
    monkeypatch.setattr(verify, "host_os", lambda: "linux")
    monkeypatch.setattr(
        verify, "collect_live_state", lambda m: collected.append("vm") or verify.LiveState(nodes=[_vm_live_node()])
    )
    monkeypatch.setattr(
        verify_baremetal, "collect_baremetal_live_state", lambda m, **kw: collected.append("bm") or _snapshot()
    )
    return collected


def test_run_verify_on_a_vm_only_manifest_never_collects_the_bare_metal_plane(monkeypatch):
    collected = _record_collectors(monkeypatch)

    code = verify.run_verify(None, _manifest([], vm_nodes=[_vm_node()]))

    assert code == 0
    assert collected == ["vm"]


def test_run_verify_on_a_bare_metal_only_manifest_never_collects_the_vm_plane(monkeypatch):
    collected = _record_collectors(monkeypatch)

    code = verify.run_verify(None, _manifest([_bm_node()]))

    assert code == 0
    assert collected == ["bm"]


def test_run_verify_collects_every_plane_the_manifest_carries(monkeypatch):
    collected = _record_collectors(monkeypatch)

    code = verify.run_verify(None, _manifest([_bm_node()], vm_nodes=[_vm_node()]))

    assert code == 0
    assert collected == ["vm", "bm"]
