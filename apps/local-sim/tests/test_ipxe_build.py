from __future__ import annotations

import importlib
from pathlib import Path

import local.ipxe_build as ib
import pytest


class _StubBridge:
    def __init__(self, repo: Path):
        self.api_repo = repo


class _StubSettings:
    def __init__(self, repo: Path):
        self.bridge = _StubBridge(repo)


@pytest.fixture
def env(tmp_path, monkeypatch):
    spoke = tmp_path / "spoke"
    bridge = spoke / "apps" / "bridge"
    (bridge / "boot" / "ipxe").mkdir(parents=True)
    (bridge / "Dockerfile").write_text("FROM scratch\n")

    builds = tmp_path / "ipxe-builds"
    monkeypatch.setattr(ib, "_IPXE_BUILDS_DIR", builds)
    monkeypatch.setattr(ib, "_STAMP_FILE", builds / ".chain-stamp.json")
    monkeypatch.setattr(ib, "get_settings", lambda: _StubSettings(spoke))
    monkeypatch.setattr(ib, "ensure_docker_running", lambda: None)
    monkeypatch.setattr(ib, "ensure_docker_buildx", lambda: None)

    calls: list[list[str]] = []

    def fake_run(*args: str) -> None:
        calls.append(list(args))
        dest = next(a.split("dest=", 1)[1] for a in args if a.startswith("type=local,dest="))
        out = Path(dest) / "export"
        for arch in ("amd64", "arm64"):
            (out / arch).mkdir(parents=True, exist_ok=True)
            for name in ib._OUTPUTS_PER_ARCH:
                (out / arch / name).write_text("bin")
        (out / "ipxe.iso").write_text("iso")

    monkeypatch.setattr(ib, "run", fake_run)
    return {"builds": builds, "calls": calls}


def _build_args_in(calls: list[list[str]]) -> list[str]:
    out: list[str] = []
    for argv in calls:
        for i, a in enumerate(argv):
            if a == "--build-arg":
                out.append(argv[i + 1])
    return out


def test_first_build_runs_and_writes_stamp(env):
    ran = ib.build_ipxe_binaries()
    assert ran is True
    stamp = env["builds"] / ".chain-stamp.json"
    assert stamp.exists()
    import json

    assert json.loads(stamp.read_text())["chain_base_url"] == ib._DEFAULT_CHAIN_BASE_URL


def test_fresh_and_matching_stamp_skips(env):
    assert ib.build_ipxe_binaries() is True
    env["calls"].clear()
    assert ib.build_ipxe_binaries() is False
    assert env["calls"] == []


def test_url_change_forces_rebuild_even_when_fresh(env):
    assert ib.build_ipxe_binaries() is True
    env["calls"].clear()
    assert ib.build_ipxe_binaries(chain_base_url="http://10.0.0.5:8000") is True
    assert env["calls"] != []
    import json

    assert json.loads((env["builds"] / ".chain-stamp.json").read_text())["chain_base_url"] == "http://10.0.0.5:8000"


def test_same_url_second_call_skips(env):
    url = "http://10.0.0.5:8000"
    assert ib.build_ipxe_binaries(chain_base_url=url) is True
    env["calls"].clear()
    assert ib.build_ipxe_binaries(chain_base_url=url) is False
    assert env["calls"] == []


def test_force_always_rebuilds(env):
    assert ib.build_ipxe_binaries() is True
    env["calls"].clear()
    assert ib.build_ipxe_binaries(force=True) is True
    assert env["calls"] != []


def test_chain_base_url_appended_to_single_buildx(env):
    ib.build_ipxe_binaries(chain_base_url="http://10.0.0.5:8000")
    assert len(env["calls"]) == 1
    assert _build_args_in(env["calls"]) == ["CHAIN_BASE_URL=http://10.0.0.5:8000"]


def test_single_buildx_targets_ipxe_export(env):
    ib.build_ipxe_binaries()
    assert len(env["calls"]) == 1
    argv = env["calls"][0]
    assert "--target" in argv
    assert argv[argv.index("--target") + 1] == "ipxe-export"


def test_all_seven_artifacts_land(env):
    assert ib.build_ipxe_binaries() is True
    builds = env["builds"]
    for arch in ("amd64", "arm64"):
        for name in ib._OUTPUTS_PER_ARCH:
            assert (builds / arch / name).is_file()
    assert (builds / "ipxe.iso").is_file()


def test_default_build_arg_when_url_is_none(env):
    ib.build_ipxe_binaries()
    assert _build_args_in(env["calls"]) == [f"CHAIN_BASE_URL={ib._DEFAULT_CHAIN_BASE_URL}"]


def test_missing_stamp_does_not_skip(env):
    assert ib.build_ipxe_binaries() is True
    (env["builds"] / ".chain-stamp.json").unlink()
    env["calls"].clear()
    assert ib.build_ipxe_binaries() is True
    assert env["calls"] != []


def test_builds_dir_honors_env_override(tmp_path, monkeypatch):
    override = tmp_path / "custom-ipxe"
    monkeypatch.setenv("LOCAL_IPXE_BUILDS_DIR", str(override))
    mod = importlib.reload(ib)
    try:
        assert mod._IPXE_BUILDS_DIR == override
        assert mod._STAMP_FILE == override / ".chain-stamp.json"
    finally:
        monkeypatch.delenv("LOCAL_IPXE_BUILDS_DIR", raising=False)
        importlib.reload(ib)


def test_builds_dir_default_unchanged_without_env(monkeypatch):
    monkeypatch.delenv("LOCAL_IPXE_BUILDS_DIR", raising=False)
    mod = importlib.reload(ib)
    assert mod._IPXE_BUILDS_DIR == Path("/opt/brokkr/ipxe-builds")
