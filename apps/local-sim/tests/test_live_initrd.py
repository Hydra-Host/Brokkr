from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from local import live_initrd
from local.config import get_settings
from local.live_initrd import (
    _AGENT_SERVICE_REL,
    LiveInitrdBuildError,
    _agent_inputs,
    _live_inputs,
    _needs_rebuild,
    _stage_agent_unit,
    build_live_initrd,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _redirect_paths(monkeypatch, hub_repo, builds_dir):
    output = builds_dir / "brokkr-live.img"
    monkeypatch.setenv("HUB_REPO_PATH", str(hub_repo))
    monkeypatch.setenv("BRIDGE_PERSISTENT_STORAGE", str(builds_dir.parent))
    get_settings.cache_clear()
    return output


@pytest.fixture
def live_layout(tmp_path, monkeypatch):
    hub_repo = tmp_path / "hub-repo"
    (hub_repo / "apps" / "bridge" / "boot" / "initrd-live").mkdir(parents=True)
    (hub_repo / "apps" / "bridge" / "boot" / "initrd-live" / "hello.sh").write_text("#!/bin/sh\necho hi\n")

    builds_dir = tmp_path / "initrd-builds"
    builds_dir.mkdir()
    output = _redirect_paths(monkeypatch, hub_repo, builds_dir)
    return hub_repo, builds_dir, output


def test_missing_repo_raises_clear_error(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_REPO_PATH", str(tmp_path / "does-not-exist"))
    get_settings.cache_clear()
    with pytest.raises(LiveInitrdBuildError, match="repo not found"):
        build_live_initrd()


def test_missing_source_tree_raises(tmp_path, monkeypatch):
    fake = tmp_path / "hub-repo"
    fake.mkdir()
    monkeypatch.setenv("HUB_REPO_PATH", str(fake))
    get_settings.cache_clear()
    with pytest.raises(LiveInitrdBuildError, match="no input files found"):
        build_live_initrd()


def test_packs_with_cpio(live_layout):
    _, _, output = live_layout

    result, rebuilt = build_live_initrd()

    assert result == output
    assert rebuilt is True
    assert output.is_file()
    assert output.stat().st_size > 0
    assert output.read_bytes()[:6] == b"070701"


def test_cpio_failure_surfaces_clear_message(live_layout):
    def fake_run(cmd, **kwargs):
        if "-o" in cmd:
            return subprocess.CompletedProcess(cmd, 1, stderr=b"cpio: pack went wrong")
        return subprocess.CompletedProcess(cmd, 0, stdout="")

    with patch.object(live_initrd.subprocess, "run", side_effect=fake_run):
        with pytest.raises(LiveInitrdBuildError, match="cpio failed"):
            build_live_initrd()


def test_cpio_silent_failure_also_caught(live_layout):
    def fake_run(cmd, **kwargs):
        if "-o" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stderr=b"")
        return subprocess.CompletedProcess(cmd, 0, stdout="")

    with patch.object(live_initrd.subprocess, "run", side_effect=fake_run):
        with pytest.raises(LiveInitrdBuildError, match="cpio failed"):
            build_live_initrd()


def test_skip_when_output_is_newer_than_sources(live_layout):
    _, _, output = live_layout
    output.write_bytes(b"070701existing-cpio-bytes\n")
    later = time.time() + 100
    os.utime(output, (later, later))

    assert _needs_rebuild(output, _live_inputs()) is False

    with patch.object(live_initrd.subprocess, "run") as run_spy:
        build_live_initrd()

    for call in run_spy.call_args_list:
        cmd = call.args[0]
        assert "-o" not in cmd, f"unexpected cpio pack call: {cmd}"


def test_force_rebuilds_even_when_fresh(live_layout):
    _, _, output = live_layout
    output.write_bytes(b"070701existing\n")
    later = time.time() + 100
    os.utime(output, (later, later))

    _, rebuilt = build_live_initrd(force=True)

    assert rebuilt is True
    assert output.is_file()
    assert output.read_bytes()[:6] == b"070701"


def test_stage_agent_unit_injects_sim_flag(tmp_path):
    src = tmp_path / "unit.service"
    src.write_text(
        "[Unit]\nDescription=x\n\n[Service]\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=multi-user.target\n"
    )
    dest = tmp_path / "out.service"

    _stage_agent_unit(src, dest)

    text = dest.read_text()
    assert "Environment=LOCAL_SIMULATION_ENABLED=true" in text
    assert text.index("LOCAL_SIMULATION_ENABLED") > text.index("[Service]")
    assert text.index("LOCAL_SIMULATION_ENABLED") < text.index("[Install]")


def test_stage_agent_unit_idempotent(tmp_path):
    src = tmp_path / "unit.service"
    src.write_text("[Service]\nEnvironment=LOCAL_SIMULATION_ENABLED=true\nEnvironment=NODE_ENV=production\n")
    dest = tmp_path / "out.service"

    _stage_agent_unit(src, dest)

    assert dest.read_text().count("LOCAL_SIMULATION_ENABLED") == 1


def test_agent_inputs_include_build_script(monkeypatch, tmp_path):
    monkeypatch.setenv("HUB_REPO_PATH", str(tmp_path))
    get_settings.cache_clear()
    assert live_initrd.__file__ in {str(p) for p in _agent_inputs()}


def test_committed_agent_unit_still_has_service_anchor(tmp_path):
    src = _REPO_ROOT / _AGENT_SERVICE_REL
    assert src.is_file(), f"agent unit missing at {src}"
    dest = tmp_path / "out.service"

    _stage_agent_unit(src, dest)

    assert "Environment=LOCAL_SIMULATION_ENABLED=true" in dest.read_text()
