from __future__ import annotations

import types

import pytest
from local import fleet as fleet_mod
from local import verify
from local.applied import AppliedBmNode, AppliedManifest, AppliedNode
from local.schema import Fleet

_NETWORK = {"name": "brokkr-net", "cidr": "192.168.200.0/24", "domain": "sim.local", "bmc_cidr": "192.168.105.0/24"}


def _manifest(nodes: list[AppliedNode], bm_nodes: list[AppliedBmNode] | None = None) -> AppliedManifest:
    return AppliedManifest(
        digest="sha256:x",
        applied_at=1.0,
        source="/x",
        network={"cidr": "192.168.200.0/24", "bmc_cidr": "192.168.105.0/24", "dhcp": False},
        nodes=nodes,
        bm_nodes=bm_nodes or [],
    )


def _bm_anode(name: str = "bm-1") -> AppliedBmNode:
    return AppliedBmNode(
        name=name,
        zone="z",
        pxe_mac="00:00:5e:00:53:a1",
        bmc_ip="10.0.0.20",
        bmc_mac="00:00:5e:00:53:c1",
        arch="amd64",
        fields={},
    )


def _anode(name: str, bmc_ip: str = "192.168.105.10", index: int = 0) -> AppliedNode:
    return AppliedNode(name=name, zone="z", index=index, ip="192.168.200.10", bmc_ip=bmc_ip, fields={})


def _lnode(name, domstate="running", ipmi=True, sushy=True, lo=True, vmnet=None) -> verify.NodeLiveState:
    return verify.NodeLiveState(
        name=name, domstate=domstate, ipmi_sim=ipmi, sushy=sushy, lo_alias_present=lo, vmnet_socket_present=vmnet
    )


def _live(nodes, tagged=None, bootptab=None) -> verify.LiveState:
    return verify.LiveState(nodes=nodes, tagged_domains=[] if tagged is None else tagged, bootptab_present=bootptab)


def _kinds(report: verify.VerifyReport) -> list[verify.FindingKind]:
    return [f.kind for f in report.findings]


def test_all_healthy_linux():
    manifest = _manifest([_anode("gpu-1"), _anode("gpu-2", bmc_ip="192.168.105.11", index=1)])
    live = _live([_lnode("gpu-1"), _lnode("gpu-2")], tagged=["gpu-1", "gpu-2"])

    report = verify.build_verify_report(manifest, live, "linux")

    assert report.status == verify.VerifyStatus.HEALTHY
    assert report.findings == []
    assert report.summary.checked == 2
    assert report.summary.ok == 2
    assert report.summary.findings == 0


def test_macos_all_healthy():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", vmnet=True)], tagged=["gpu-1"], bootptab=True)

    report = verify.build_verify_report(manifest, live, "macos")

    assert report.status == verify.VerifyStatus.HEALTHY
    assert report.findings == []


def test_domain_not_running_is_healable():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", domstate="shut off")], tagged=["gpu-1"])

    report = verify.build_verify_report(manifest, live, "linux")

    assert report.status == verify.VerifyStatus.FINDINGS
    assert _kinds(report) == [verify.FindingKind.DOMAIN_NOT_RUNNING]
    assert report.findings[0].healable is True
    assert report.findings[0].node == "gpu-1"
    assert report.summary.ok == 0


def test_domain_undefined_is_not_healable_and_sole_finding():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", domstate="undefined", ipmi=False, sushy=False, lo=False)], tagged=["gpu-1"])

    report = verify.build_verify_report(manifest, live, "linux")

    assert _kinds(report) == [verify.FindingKind.DOMAIN_UNDEFINED]
    assert report.findings[0].healable is False


def test_daemon_and_alias_findings_are_healable():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", ipmi=False, sushy=False, lo=False)], tagged=["gpu-1"])

    report = verify.build_verify_report(manifest, live, "linux")

    assert _kinds(report) == [
        verify.FindingKind.IPMI_SIM_DOWN,
        verify.FindingKind.SUSHY_DOWN,
        verify.FindingKind.LO_ALIAS_MISSING,
    ]
    assert all(f.healable for f in report.findings)


def test_macos_vmnet_socket_missing_is_healable():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", vmnet=False)], tagged=["gpu-1"], bootptab=True)

    report = verify.build_verify_report(manifest, live, "macos")

    assert _kinds(report) == [verify.FindingKind.VMNET_SOCKET_MISSING]
    assert report.findings[0].healable is True


def test_macos_bootptab_missing_is_healable_fleet_level():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", vmnet=True)], tagged=["gpu-1"], bootptab=False)

    report = verify.build_verify_report(manifest, live, "macos")

    finding = next(f for f in report.findings if f.kind == verify.FindingKind.BOOTPTAB_MISSING)
    assert finding.node is None
    assert finding.healable is True


def test_linux_skips_vmnet_and_bootptab_checks():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1", vmnet=None)], tagged=["gpu-1"], bootptab=None)

    report = verify.build_verify_report(manifest, live, "linux")

    assert report.status == verify.VerifyStatus.HEALTHY
    assert report.findings == []


def test_manifest_with_empty_rosters_reports_healthy_and_no_planes_on():
    report = verify.build_verify_report(_manifest([]), None, "linux")

    assert report.status == verify.VerifyStatus.HEALTHY
    assert report.planes == verify.VerifyPlanes(vm=False, baremetal=False)
    assert report.findings == []
    assert report.summary.checked == 0


def test_report_planes_follow_the_manifest_rosters():
    vm_only = verify.build_verify_report(_manifest([_anode("gpu-1")]), _live([_lnode("gpu-1")]), "linux")
    assert vm_only.planes == verify.VerifyPlanes(vm=True, baremetal=False)

    both = verify.build_verify_report(_manifest([_anode("gpu-1")], [_bm_anode()]), _live([_lnode("gpu-1")]), "linux")
    assert both.planes == verify.VerifyPlanes(vm=True, baremetal=True)
    assert both.model_dump_wire()["planes"] == {"vm": True, "baremetal": True}


def test_no_manifest_reports_single_non_healable_finding():
    report = verify.build_verify_report(None, None, "linux")

    assert report.status == verify.VerifyStatus.NO_MANIFEST
    assert report.planes is None
    assert _kinds(report) == [verify.FindingKind.NO_MANIFEST]
    assert report.findings[0].healable is False
    assert report.summary.checked == 0
    assert report.summary.findings == 1


def test_orphan_domain_detected_and_not_healable():
    manifest = _manifest([_anode("gpu-1")])
    live = _live([_lnode("gpu-1")], tagged=["gpu-1", "ghost-9"])

    report = verify.build_verify_report(manifest, live, "linux")

    orphans = [f for f in report.findings if f.kind == verify.FindingKind.ORPHAN_DOMAIN]
    assert len(orphans) == 1
    assert orphans[0].node == "ghost-9"
    assert orphans[0].healable is False
    assert report.summary.ok == 1
    assert report.summary.checked == 1


def test_summary_counts_ok_and_total_findings():
    manifest = _manifest(
        [
            _anode("gpu-1"),
            _anode("gpu-2", bmc_ip="192.168.105.11", index=1),
            _anode("gpu-3", bmc_ip="192.168.105.12", index=2),
        ]
    )
    live = _live(
        [
            _lnode("gpu-1"),
            _lnode("gpu-2", ipmi=False),
            _lnode("gpu-3", domstate="shut off", sushy=False),
        ],
        tagged=["gpu-1", "gpu-2", "gpu-3"],
    )

    report = verify.build_verify_report(manifest, live, "linux")

    assert report.summary.checked == 3
    assert report.summary.ok == 1
    assert report.summary.findings == 3
    assert report.status == verify.VerifyStatus.FINDINGS


def _fleet(dhcp: bool = False) -> Fleet:
    return Fleet.model_validate(
        {
            "network": {**_NETWORK, "dhcp": dhcp},
            "nodes": [
                {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
                {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02"},
            ],
        }
    )


def _finding(kind, node, healable=True) -> verify.VerifyFinding:
    return verify.VerifyFinding(node=node, kind=kind, healable=healable, detail="x")


def _report(findings) -> verify.VerifyReport:
    return verify.VerifyReport(
        status=verify.VerifyStatus.FINDINGS,
        planes=verify.VerifyPlanes(vm=True, baremetal=False),
        findings=findings,
        summary=verify.VerifySummary(checked=2, ok=0, findings=len(findings)),
    )


def _no_drift(monkeypatch):
    diff = types.SimpleNamespace(nodes=types.SimpleNamespace(changed=[], added=[], removed=[]), in_sync=True)
    monkeypatch.setattr(verify.applied, "diff", lambda *a, **k: diff)


def test_heal_noop_when_nothing_healable(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(verify.applied, "diff", lambda *a, **k: called.append("diff"))
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: called.append("sudo"))

    verify.heal_findings(
        _fleet(), object(), _report([_finding(verify.FindingKind.ORPHAN_DOMAIN, "ghost", False)]), "linux"
    )

    assert called == []


def test_heal_refuses_when_finding_node_has_drifted(monkeypatch):
    diff = types.SimpleNamespace(
        nodes=types.SimpleNamespace(changed=[types.SimpleNamespace(name="gpu-1")], added=[], removed=[]),
        in_sync=False,
    )
    monkeypatch.setattr(verify.applied, "diff", lambda *a, **k: diff)
    sudo_calls: list[bool] = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: sudo_calls.append(True))

    with pytest.raises(SystemExit) as exc:
        verify.heal_findings(
            _fleet(), object(), _report([_finding(verify.FindingKind.IPMI_SIM_DOWN, "gpu-1")]), "linux"
        )

    assert "gpu-1" in str(exc.value)
    assert sudo_calls == []


def test_heal_refuses_fleet_wide_repairs_on_network_only_drift(monkeypatch):
    diff = types.SimpleNamespace(nodes=types.SimpleNamespace(changed=[], added=[], removed=[]), in_sync=False)
    monkeypatch.setattr(verify.applied, "diff", lambda *a, **k: diff)
    sudo_calls: list[bool] = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: sudo_calls.append(True))

    with pytest.raises(SystemExit) as exc:
        verify.heal_findings(
            _fleet(), object(), _report([_finding(verify.FindingKind.BOOTPTAB_MISSING, None)]), "macos"
        )

    assert "bootptab-missing" in str(exc.value)
    assert sudo_calls == []


def test_heal_resumes_a_paused_domain_instead_of_starting_it(monkeypatch):
    _no_drift(monkeypatch)
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(verify, "_virsh_domstate", lambda name: "paused")
    monkeypatch.setattr(verify, "virsh", lambda *a, **k: calls.append(a))

    verify.heal_findings(
        _fleet(), object(), _report([_finding(verify.FindingKind.DOMAIN_NOT_RUNNING, "gpu-1")]), "linux"
    )

    assert calls == [("resume", "gpu-1")]


def test_heal_maps_each_finding_to_its_repair(monkeypatch):
    _no_drift(monkeypatch)
    calls: list = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: calls.append(("sudo",)))
    monkeypatch.setattr(verify, "add_lo_alias", lambda ip: calls.append(("lo", ip)))
    monkeypatch.setattr(verify, "start_ipmi_sim", lambda node, bmc, port: calls.append(("ipmi", node.name, bmc)))
    monkeypatch.setattr(verify, "start_sushy_emulator", lambda node, bmc: calls.append(("sushy", node.name, bmc)))
    monkeypatch.setattr(verify, "virsh", lambda *a, **k: calls.append(("virsh", a)))
    monkeypatch.setattr(verify, "_virsh_domstate", lambda name: "shut off")
    monkeypatch.setattr(verify, "start_socket_vmnet", lambda fleet: calls.append(("vmnet",)) or [])
    monkeypatch.setattr(verify, "write_bootptab", lambda fleet: calls.append(("bootptab",)))
    monkeypatch.setattr(verify, "_recover_orphaned_nics", lambda r: [])

    report = _report(
        [
            _finding(verify.FindingKind.DOMAIN_NOT_RUNNING, "gpu-1"),
            _finding(verify.FindingKind.IPMI_SIM_DOWN, "gpu-1"),
            _finding(verify.FindingKind.LO_ALIAS_MISSING, "gpu-1"),
            _finding(verify.FindingKind.SUSHY_DOWN, "gpu-2"),
            _finding(verify.FindingKind.ORPHAN_DOMAIN, "ghost", healable=False),
        ]
    )
    verify.heal_findings(_fleet(), object(), report, "linux")

    assert ("sudo",) in calls
    assert ("lo", "192.168.105.10") in calls
    assert ("ipmi", "gpu-1", "192.168.105.10") in calls
    assert ("sushy", "gpu-2", "192.168.105.11") in calls
    assert ("virsh", ("start", "gpu-1")) in calls
    assert ("bootptab",) not in calls
    assert ("vmnet",) not in calls
    assert calls.index(("lo", "192.168.105.10")) < calls.index(("ipmi", "gpu-1", "192.168.105.10"))
    assert not any(c[0] == "virsh" and c[1] == ("start", "ghost") for c in calls)


def test_heal_macos_restarts_vmnet_and_recovers_nics(monkeypatch):
    _no_drift(monkeypatch)
    calls: list = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(verify, "write_bootptab", lambda fleet: calls.append("bootptab"))
    monkeypatch.setattr(verify, "start_socket_vmnet", lambda fleet: calls.append("vmnet") or ["gpu-1"])
    monkeypatch.setattr(verify, "_recover_orphaned_nics", lambda r: calls.append(("recover", r)) or ["gpu-1"])
    monkeypatch.setattr(
        verify, "_redefine_and_restart", lambda fleet, node, idx: calls.append(("redefine", node.name, idx))
    )
    monkeypatch.setattr(verify, "add_lo_alias", lambda ip: calls.append(("lo", ip)))

    report = _report(
        [
            _finding(verify.FindingKind.BOOTPTAB_MISSING, None),
            _finding(verify.FindingKind.VMNET_SOCKET_MISSING, "gpu-1"),
        ]
    )
    verify.heal_findings(_fleet(), object(), report, "macos")

    assert "bootptab" in calls
    assert "vmnet" in calls
    assert ("recover", ["gpu-1"]) in calls
    assert ("redefine", "gpu-1", 0) in calls
    assert calls.index("bootptab") < calls.index("vmnet")


def test_heal_skips_virsh_when_domain_already_running_crg(monkeypatch):
    _no_drift(monkeypatch)
    calls: list = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(verify, "_virsh_domstate", lambda name: "running")
    monkeypatch.setattr(verify, "virsh", lambda *a, **k: calls.append(a))

    verify.heal_findings(
        _fleet(), object(), _report([_finding(verify.FindingKind.DOMAIN_NOT_RUNNING, "gpu-1")]), "linux"
    )

    assert calls == []


def test_heal_macos_grants_bpf_before_vmnet_when_dhcp_bugbot(monkeypatch):
    _no_drift(monkeypatch)
    calls: list = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleet_mod, "grant_bpf", lambda: calls.append("bpf"))
    monkeypatch.setattr(verify, "start_socket_vmnet", lambda fleet: calls.append("vmnet") or [])
    monkeypatch.setattr(verify, "_recover_orphaned_nics", lambda r: [])

    verify.heal_findings(
        _fleet(dhcp=True), object(), _report([_finding(verify.FindingKind.VMNET_SOCKET_MISSING, "gpu-1")]), "macos"
    )

    assert calls == ["bpf", "vmnet"]


def test_heal_macos_skips_bpf_grant_when_dhcp_disabled_bugbot(monkeypatch):
    _no_drift(monkeypatch)
    calls: list = []
    monkeypatch.setattr(verify, "ensure_sudo_cached", lambda: None)
    monkeypatch.setattr(fleet_mod, "grant_bpf", lambda: calls.append("bpf"))
    monkeypatch.setattr(verify, "start_socket_vmnet", lambda fleet: calls.append("vmnet") or [])
    monkeypatch.setattr(verify, "_recover_orphaned_nics", lambda r: [])

    verify.heal_findings(
        _fleet(dhcp=False), object(), _report([_finding(verify.FindingKind.VMNET_SOCKET_MISSING, "gpu-1")]), "macos"
    )

    assert calls == ["vmnet"]
