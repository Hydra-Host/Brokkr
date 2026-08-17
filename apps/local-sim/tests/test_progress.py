"""fleet-progress.json writer — the structured, enum-driven bring-up signal the control center reads."""

from __future__ import annotations

import json

from local import progress
from local.progress import BRINGUP_SEQUENCE, Phase, Step


def test_set_started_records_enum_phase_step_ordinal(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.set(Step.BUILD_LIVE_IMG, started=True)
    p = progress.read()
    assert p["phase"] == Phase.INIT.value and p["step"] == Step.BUILD_LIVE_IMG.value
    assert p["label"]  # derived from STEP_LABEL, non-empty
    assert p["stepOrdinal"] == 0 and p["stepCount"] == len(BRINGUP_SEQUENCE)
    assert p["startedAt"] > 0 and p["updatedAt"] >= p["startedAt"] and p["error"] is None


def test_ordinal_advances_with_the_sequence(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.set(Step.BUILD_IPXE, node="cpu-3", index=3, total=4, started=True)
    p = progress.read()
    assert p["step"] == "build-ipxe" and p["phase"] == "init"
    assert p["stepOrdinal"] == BRINGUP_SEQUENCE.index(Step.BUILD_IPXE)
    assert p["node"] == "cpu-3" and p["index"] == 3 and p["total"] == 4


def test_off_sequence_step_has_ordinal_minus_one(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.set(Step.TEARING_DOWN)
    assert progress.read()["stepOrdinal"] == -1


def test_set_preserves_startedat_across_updates(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.set(Step.BUILD_LIVE_IMG, started=True)
    started = progress.read()["startedAt"]
    progress.set(Step.POWER_ON, total=4)
    assert progress.read()["startedAt"] == started


def test_clear_removes_the_file_and_write_is_valid_json(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.set(Step.READY, started=True)
    json.loads(progress.progress_path().read_text())  # parses → never torn
    progress.clear()
    assert progress.read() is None


def test_error_records_failure_on_current_step(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.set(Step.BUILD_IPXE, node="cpu-1", index=1, total=4, started=True)
    progress.error("spoke could not serve brokkr-discovery-x.img")
    p = progress.read()
    # error stamped, step/phase/node preserved (UI shows WHERE it failed), startedAt kept
    assert p["error"] == "spoke could not serve brokkr-discovery-x.img"
    assert p["step"] == "build-ipxe" and p["phase"] == "init" and p["node"] == "cpu-1"


def test_error_without_prior_record_still_surfaces(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    progress.error("boom")
    p = progress.read()
    assert p is not None and p["error"] == "boom"
