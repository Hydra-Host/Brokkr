from __future__ import annotations

import io
import json
import types

import pytest
from local import discover
from local.hub_client import HubClient, HubUnreachable
from local.logger import Logger


def _server_with_disks(count: int) -> dict:
    return {"storageLayouts": {"configs": [{"disk_group_name": "g", "disks": ["sda"] * count}]}}


def _capture_log(monkeypatch) -> io.StringIO:
    buf = io.StringIO()
    monkeypatch.setattr(discover, "log", Logger(stdout=buf, stderr=buf))
    return buf


def test_discover_reports_enqueue_and_watches_completion(monkeypatch):
    node = types.SimpleNamespace(name="gpu-1")
    monkeypatch.setattr(discover, "load_fleet", lambda: types.SimpleNamespace(nodes=[node]))
    monkeypatch.setattr(discover, "_node_device_ids", lambda fleet: {"gpu-1": "00000000-0000-0000-0000-0000000abcde"})
    monkeypatch.setattr(discover.time, "sleep", lambda _s: None)  # don't wait between polls
    monkeypatch.setattr(HubClient, "sign_in", lambda self: None)
    out = _capture_log(monkeypatch)

    reads = iter([(200, _server_with_disks(1)), (200, _server_with_disks(2))])
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: next(reads))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "job-abc123"}))

    discover.main(["0"])  # clean exit, no SystemExit

    logged = out.getvalue()
    assert "job-abc123" in logged, "must report the enqueued jobId"
    assert "enqueued" in logged
    assert "discovery landed" in logged


def test_discover_fails_when_collect_inventory_rejected(monkeypatch):
    node = types.SimpleNamespace(name="gpu-1")
    monkeypatch.setattr(discover, "load_fleet", lambda: types.SimpleNamespace(nodes=[node]))
    monkeypatch.setattr(discover, "_node_device_ids", lambda fleet: {"gpu-1": "00000000-0000-0000-0000-0000000abcde"})
    monkeypatch.setattr(HubClient, "sign_in", lambda self: None)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, {"storageLayouts": {"configs": []}}))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (403, {"message": "forbidden"}))
    out = _capture_log(monkeypatch)

    with pytest.raises(SystemExit) as exc:
        discover.main(["0"])

    assert str(exc.value).startswith("error:")

    logged = out.getvalue()
    assert "discovery on" not in logged, "must not claim progress before a failed enqueue"
    assert "enqueued" not in logged, "must not claim inventory_collection was enqueued"


def _wire_node(monkeypatch):
    node = types.SimpleNamespace(name="gpu-1")
    monkeypatch.setattr(discover, "load_fleet", lambda: types.SimpleNamespace(nodes=[node]))
    monkeypatch.setattr(discover, "_node_device_ids", lambda fleet: {"gpu-1": "00000000-0000-0000-0000-0000000abcde"})
    monkeypatch.setattr(discover.time, "sleep", lambda _s: None)
    monkeypatch.setattr(HubClient, "sign_in", lambda self: None)


def test_discover_fails_when_enqueue_returns_no_job_id(monkeypatch):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, _server_with_disks(1)))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {}))
    out = _capture_log(monkeypatch)

    with pytest.raises(SystemExit) as exc:
        discover.main(["0"])

    assert str(exc.value).startswith("error:")
    assert "enqueued" not in out.getvalue()


def test_discover_fails_when_baseline_read_fails(monkeypatch):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (503, None))
    enqueued: list[str] = []
    monkeypatch.setattr(
        HubClient, "force_discovery", lambda self, device_id: enqueued.append(device_id) or (200, {"jobId": "j"})
    )
    out = _capture_log(monkeypatch)

    with pytest.raises(SystemExit) as exc:
        discover.main(["0"])

    assert str(exc.value).startswith("error:")
    assert enqueued == [], "must not enqueue on a failed baseline"
    assert "enqueued" not in out.getvalue()


def test_discover_poll_skips_failed_reads(monkeypatch):
    _wire_node(monkeypatch)
    reads = iter([(200, _server_with_disks(1)), (500, None), (200, _server_with_disks(2))])
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: next(reads))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "j"}))
    out = _capture_log(monkeypatch)

    discover.main(["0"])

    logged = out.getvalue()
    assert "discovery landed" in logged
    assert "read failed (500)" in logged, "the failed poll must be retried, not compared"


def test_discover_poll_retries_when_hub_unreachable(monkeypatch):
    _wire_node(monkeypatch)

    reads = iter(["baseline", "outage", "landed"])

    def fake_get_server(self, device_id):
        step = next(reads)
        if step == "outage":
            raise HubUnreachable("hub api not reachable")
        return (200, _server_with_disks(1 if step == "baseline" else 2))

    monkeypatch.setattr(HubClient, "get_server", fake_get_server)
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "j"}))
    out = _capture_log(monkeypatch)

    discover.main(["0"])

    logged = out.getvalue()
    assert "discovery landed" in logged
    assert "hub unreachable — retrying" in logged


def test_discover_fails_when_node_has_no_seeded_device(monkeypatch):
    node = types.SimpleNamespace(name="gpu-1")
    monkeypatch.setattr(discover, "load_fleet", lambda: types.SimpleNamespace(nodes=[node]))
    monkeypatch.setattr(discover, "_node_device_ids", lambda fleet: {})

    with pytest.raises(SystemExit) as exc:
        discover.main(["0"])

    assert "no seeded Hub device row" in str(exc.value)


def test_discover_timeout_exits_two(monkeypatch):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, _server_with_disks(1)))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "j"}))

    with pytest.raises(SystemExit) as exc:
        discover.main(["0", "--timeout", "0"])

    assert exc.value.code == 2


def test_discover_timeout_honored_via_clock(monkeypatch):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, _server_with_disks(1)))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "j"}))
    ticks = iter([1000.0, 1005.0, 1015.0, 1035.0])
    monkeypatch.setattr(discover.time, "time", lambda: next(ticks, 9999.0))

    with pytest.raises(SystemExit) as exc:
        discover.main(["0", "--timeout", "30"])

    assert exc.value.code == 2


def test_discover_short_timeout_caps_sleep_to_remaining_budget_bugbot(monkeypatch):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, _server_with_disks(1)))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "j"}))
    slept: list[float] = []
    monkeypatch.setattr(discover.time, "sleep", lambda s: slept.append(s))
    ticks = iter([1000.0, 1001.0, 1004.0])
    monkeypatch.setattr(discover.time, "time", lambda: next(ticks, 9999.0))
    _capture_log(monkeypatch)

    with pytest.raises(SystemExit) as exc:
        discover.main(["0", "--timeout", "3"])

    assert exc.value.code == 2
    assert slept == [2.0]


def test_discover_hard_failure_exits_one_not_two(monkeypatch):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, _server_with_disks(1)))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (403, {"message": "no"}))

    with pytest.raises(SystemExit) as exc:
        discover.main(["0"])

    assert exc.value.code != 2
    assert str(exc.value).startswith("error:")


def test_discover_json_emits_single_doc_to_stdout(monkeypatch, capsys):
    _wire_node(monkeypatch)
    reads = iter([(200, _server_with_disks(1)), (200, _server_with_disks(3))])
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: next(reads))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "job-xyz"}))
    buf = _capture_log(monkeypatch)

    discover.main(["0", "--json"])

    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["node"] == "gpu-1"
    assert payload["deviceId"] == "00000000-0000-0000-0000-0000000abcde"
    assert payload["jobId"] == "job-xyz"
    assert payload["disksBefore"] == 1
    assert payload["disksAfter"] == 3
    assert payload["landed"] is True
    assert payload["timedOut"] is False
    assert "enqueued" not in out
    assert "enqueued" in buf.getvalue()


def test_discover_json_timeout_doc_marks_timed_out(monkeypatch, capsys):
    _wire_node(monkeypatch)
    monkeypatch.setattr(HubClient, "get_server", lambda self, device_id: (200, _server_with_disks(2)))
    monkeypatch.setattr(HubClient, "force_discovery", lambda self, device_id: (200, {"jobId": "j"}))
    _capture_log(monkeypatch)

    with pytest.raises(SystemExit) as exc:
        discover.main(["0", "--json", "--timeout", "0"])

    assert exc.value.code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["landed"] is False
    assert payload["timedOut"] is True
    assert payload["disksBefore"] == 2
    assert payload["disksAfter"] == 2
