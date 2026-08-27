from __future__ import annotations

import json

import pytest
from local import commission_baremetal as ob
from local.commission_baremetal import (
    POLL_ABSENT,
    POLL_FAILED,
    POLL_IN_PROGRESS,
    POLL_QUALIFIED,
    BareMetalNode,
    BmcCreds,
    CommissionError,
    classify_progress_item,
    find_progress_item,
    main,
)
from local.hub_client import HubClient

DEVICE_ID = "dev-1"
NODE = BareMetalNode(name="bench-1", bmc_ip="198.51.100.250", bmc_mac="aa:bb:cc:dd:ee:ff", pxe_mac="00:00:5e:00:53:b4")
CREDS = BmcCreds(username="admin", password="secret")


def _progress_body(item: dict | None) -> dict:
    return {"success": True, "data": [item] if item is not None else []}


def _item(**overrides) -> dict:
    base = {
        "deviceId": DEVICE_ID,
        "lifecycleQualified": False,
        "lifecycleFailed": False,
        "sagaSteps": [],
    }
    base.update(overrides)
    return base


def test_classify_qualified():
    assert classify_progress_item(_item(lifecycleQualified=True)) == POLL_QUALIFIED


def test_classify_failed():
    assert classify_progress_item(_item(lifecycleFailed=True)) == POLL_FAILED


def test_classify_failed_wins_over_qualified():
    assert classify_progress_item(_item(lifecycleFailed=True, lifecycleQualified=True)) == POLL_FAILED


def test_classify_in_progress():
    assert classify_progress_item(_item()) == POLL_IN_PROGRESS


def test_classify_absent():
    assert classify_progress_item(None) == POLL_ABSENT


def test_find_progress_item_present():
    item = _item()
    assert find_progress_item(_progress_body(item), DEVICE_ID) == item


def test_find_progress_item_missing():
    assert find_progress_item(_progress_body(_item(deviceId="other")), DEVICE_ID) is None


@pytest.mark.parametrize("body", [None, "not-a-dict", {}, {"data": None}, {"data": "x"}, {"data": [1, 2]}])
def test_find_progress_item_malformed_reads_as_absent(body):
    assert find_progress_item(body, DEVICE_ID) is None


def _install_progress_sequence(monkeypatch, bodies):
    calls = {"n": 0}

    def fake_progress(self, zone_id):
        i = min(calls["n"], len(bodies) - 1)
        calls["n"] += 1
        return bodies[i]

    monkeypatch.setattr(HubClient, "commissioning_progress", fake_progress)
    monkeypatch.setattr(ob.time, "sleep", lambda _s: None)
    return calls


def test_poll_in_progress_then_qualified(monkeypatch):
    running_step = {"name": "reboot_to_live", "phase": "commission", "status": "running"}
    _install_progress_sequence(
        monkeypatch,
        [
            (200, _progress_body(None)),
            (200, _progress_body(_item(sagaSteps=[running_step]))),
            (200, _progress_body(_item(lifecycleQualified=True))),
        ],
    )
    client = HubClient()
    ob._poll_until_terminal(client, NODE, DEVICE_ID, timeout_seconds=999)


def test_poll_in_progress_then_failed(monkeypatch):
    _install_progress_sequence(
        monkeypatch,
        [
            (200, _progress_body(_item())),
            (
                200,
                _progress_body(
                    _item(
                        lifecycleFailed=True,
                        sagaSteps=[{"name": "disk_wipe", "phase": "commission", "status": "failed", "error": "boom"}],
                    )
                ),
            ),
        ],
    )
    client = HubClient()
    with pytest.raises(CommissionError, match=r"commissioning failed.*disk_wipe.*boom"):
        ob._poll_until_terminal(client, NODE, DEVICE_ID, timeout_seconds=999)


def test_poll_times_out(monkeypatch):
    _install_progress_sequence(monkeypatch, [(200, _progress_body(_item()))])
    times = iter([0.0, 100.0, 200.0, 300.0])
    monkeypatch.setattr(ob.time, "monotonic", lambda: next(times))
    client = HubClient()
    with pytest.raises(CommissionError, match="timed out"):
        ob._poll_until_terminal(client, NODE, DEVICE_ID, timeout_seconds=1)


def test_poll_tolerates_non_200_then_qualifies(monkeypatch):
    _install_progress_sequence(
        monkeypatch,
        [
            (503, None),
            (200, _progress_body(_item(lifecycleQualified=True))),
        ],
    )
    client = HubClient()
    ob._poll_until_terminal(client, NODE, DEVICE_ID, timeout_seconds=999)


def test_yes_wipe_required(monkeypatch):
    called = {"run": False}
    monkeypatch.setattr(ob, "run", lambda *a, **k: called.__setitem__("run", True) or 0)
    assert main([]) == 2
    assert called["run"] is False


def test_yes_wipe_allows_run(monkeypatch):
    called = {"args": None}

    def fake_run(name, timeout_minutes):
        called["args"] = (name, timeout_minutes)
        return 0

    monkeypatch.setattr(ob, "run", fake_run)
    assert main(["--yes-wipe", "--node", "bench-1", "--timeout", "10"]) == 0
    assert called["args"] == ("bench-1", 10)


def test_nonpositive_timeout_rejected(monkeypatch):
    monkeypatch.setattr(ob, "run", lambda *a, **k: 0)
    assert main(["--yes-wipe", "--timeout", "0"]) == 2


def test_load_bmc_creds_ok(tmp_path):
    p = tmp_path / "bmc-creds.json"
    p.write_text(json.dumps({"bench-1": {"user": "admin", "pass": "s3cret"}}))
    creds = ob.load_bmc_creds("bench-1", creds_path=p)
    assert creds == BmcCreds(username="admin", password="s3cret")


def test_load_bmc_creds_defaults_fallback(tmp_path):
    # No per-node entry → fall back to the shared `defaults` entry (single-box bench).
    p = tmp_path / "bmc-creds.json"
    p.write_text(json.dumps({"defaults": {"user": "admin", "pass": "s3cret"}}))
    creds = ob.load_bmc_creds("box-1", creds_path=p)
    assert creds == BmcCreds(username="admin", password="s3cret")


def test_load_bmc_creds_node_wins_over_defaults(tmp_path):
    p = tmp_path / "bmc-creds.json"
    p.write_text(json.dumps({"defaults": {"user": "d", "pass": "dp"}, "box-1": {"user": "n", "pass": "np"}}))
    assert ob.load_bmc_creds("box-1", creds_path=p) == BmcCreds(username="n", password="np")


def test_load_bmc_creds_missing_file(tmp_path):
    with pytest.raises(CommissionError, match="not found"):
        ob.load_bmc_creds("bench-1", creds_path=tmp_path / "nope.json")


def test_load_bmc_creds_missing_node(tmp_path):
    p = tmp_path / "bmc-creds.json"
    p.write_text(json.dumps({"other": {"user": "a", "pass": "b"}}))
    with pytest.raises(CommissionError, match="no entry for node"):
        ob.load_bmc_creds("bench-1", creds_path=p)


def test_load_bmc_creds_never_leaks_password(tmp_path):
    p = tmp_path / "bmc-creds.json"
    p.write_text(json.dumps({"bench-1": {"user": "admin", "pass": ""}}))
    with pytest.raises(CommissionError) as exc:
        ob.load_bmc_creds("bench-1", creds_path=p)
    assert "s3cret" not in str(exc.value)


def _write_fleet(tmp_path, body):
    import yaml as _yaml

    p = tmp_path / "fleet.yml"
    p.write_text(_yaml.safe_dump(body))
    return p


def test_load_baremetal_nodes_ok(tmp_path):
    p = _write_fleet(
        tmp_path,
        {
            "baremetal": {
                "arch": "amd64",
                "nodes": [
                    {
                        "name": "bench-1",
                        "bmc_ip": "198.51.100.250",
                        "bmc_mac": "aa:bb:cc:dd:ee:ff",
                        "pxe_mac": "00:00:5e:00:53:b4",
                    },
                ],
            }
        },
    )
    nodes = ob.load_baremetal_nodes(fleet_path=p)
    assert nodes == [
        BareMetalNode(
            name="bench-1",
            bmc_ip="198.51.100.250",
            bmc_mac="aa:bb:cc:dd:ee:ff",
            pxe_mac="00:00:5e:00:53:b4",
            arch="amd64",
        )
    ]


def test_load_baremetal_nodes_no_block(tmp_path):
    p = _write_fleet(tmp_path, {"network": {}, "nodes": []})
    with pytest.raises(CommissionError, match="not in bare-metal mode"):
        ob.load_baremetal_nodes(fleet_path=p)


def test_load_baremetal_nodes_missing_field(tmp_path):
    p = _write_fleet(tmp_path, {"baremetal": {"nodes": [{"name": "x", "bmc_ip": "1.2.3.4"}]}})
    with pytest.raises(CommissionError, match="missing required field"):
        ob.load_baremetal_nodes(fleet_path=p)
