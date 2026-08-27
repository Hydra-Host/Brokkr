"""Prefetch must not silently keep a stale discovery image when the spoke can't serve it — the silent
keep-stale path is what hid the discovery-initrd-build deadlock behind a bland 'stopped'."""

from __future__ import annotations

import io
import subprocess
import types
from subprocess import CalledProcessError

import pytest
from local import prefetch
from local.logger import Logger


def _capture_log(monkeypatch) -> io.StringIO:
    out = io.StringIO()
    monkeypatch.setattr(prefetch, "log", Logger(stdout=out, stderr=out))
    return out


def _fake_run(returncode: int, head_stdout: str = "", get_returncode: int | None = None):
    def fake(*cmd, check: bool = True, capture: bool = False, **kw):
        fake.calls.append([str(c) for c in cmd])
        is_head = "-I" in fake.calls[-1]
        rc = returncode if is_head or get_returncode is None else get_returncode
        return subprocess.CompletedProcess(fake.calls[-1], rc, stdout=head_stdout if is_head else "", stderr="")

    fake.calls: list[list[str]] = []
    return fake


def _prefetch_env(tmp_path, monkeypatch):
    settings = types.SimpleNamespace(state=types.SimpleNamespace(boot_artifact_root=tmp_path))
    monkeypatch.setattr(prefetch, "get_settings", lambda: settings)
    monkeypatch.setattr(prefetch, "zone_endpoint", lambda _o=0: "http://127.0.0.1:8000")
    node = types.SimpleNamespace(name="cpu-1", arch="arm64")
    boot_dir = tmp_path / node.arch
    boot_dir.mkdir(parents=True, exist_ok=True)
    return node, boot_dir / "brokkr-discovery-dev-1.img"


def test_fetch_if_missing_redownloads_when_remote_size_unverifiable(tmp_path, monkeypatch):
    """A None remote size (HEAD failed: spoke down / 404) must NOT be treated as up-to-date."""
    dest = tmp_path / "img"
    dest.write_bytes(b"stale")
    monkeypatch.setattr(prefetch, "remote_size", lambda *a, **k: None)
    calls = _fake_run(0)
    monkeypatch.setattr(prefetch, "run", calls)
    prefetch.fetch_if_missing("http://spoke/x.img", dest)
    assert [c for c in calls.calls if "-o" in c], "an unverifiable remote must force a re-download, not silently skip"


def test_fetch_if_missing_skips_only_on_verified_match(tmp_path, monkeypatch):
    dest = tmp_path / "img"
    dest.write_bytes(b"12345")
    monkeypatch.setattr(prefetch, "remote_size", lambda *a, **k: 5)  # matches len("12345")
    monkeypatch.setattr(prefetch, "run", lambda *a, **k: pytest.fail("must not re-download a verified match"))
    prefetch.fetch_if_missing("http://spoke/x.img", dest)


def test_fetch_if_missing_raises_on_get_failure(tmp_path, monkeypatch):
    """When the spoke 404s, the GET (curl -fS) raises — the failure surfaces instead of being swallowed."""
    dest = tmp_path / "img"

    def boom(*a, **k):
        raise CalledProcessError(22, "curl")

    monkeypatch.setattr(prefetch, "run", boom)
    with pytest.raises(CalledProcessError):
        prefetch.fetch_if_missing("http://spoke/x.img", dest)


def test_fetch_if_missing_keeps_the_cached_file_when_the_spoke_is_unreachable(tmp_path, monkeypatch):
    dest = tmp_path / "img"
    dest.write_bytes(b"good-cached-image")
    monkeypatch.setattr(prefetch, "run", _fake_run(7))
    with pytest.raises(prefetch.SpokeUnreachableError):
        prefetch.fetch_if_missing("http://spoke/x.img", dest)
    assert dest.read_bytes() == b"good-cached-image"


def test_discovery_prefetch_skips_and_keeps_cache_when_the_spoke_is_unreachable(tmp_path, monkeypatch):
    node, target = _prefetch_env(tmp_path, monkeypatch)
    target.write_bytes(b"good-cached-image")
    calls = _fake_run(7)
    monkeypatch.setattr(prefetch, "run", calls)
    out = _capture_log(monkeypatch)

    assert prefetch.prefetch_node_discovery_initrd(node, "dev-1") == target
    assert target.read_bytes() == b"good-cached-image"
    assert not any("-o" in call for call in calls.calls)
    assert "spoke unreachable" in out.getvalue()
    assert "iPXE boot" in out.getvalue()


def test_discovery_prefetch_still_raises_when_the_spoke_answers_with_an_error(tmp_path, monkeypatch):
    node, _ = _prefetch_env(tmp_path, monkeypatch)
    monkeypatch.setattr(prefetch, "run", _fake_run(22))
    with pytest.raises(RuntimeError, match="spoke could not serve"):
        prefetch.prefetch_node_discovery_initrd(node, "dev-1")


def test_discovery_prefetch_still_raises_when_the_spoke_serves_a_short_image(tmp_path, monkeypatch):
    node, target = _prefetch_env(tmp_path, monkeypatch)
    target.write_bytes(b"truncated")
    monkeypatch.setattr(prefetch, "run", _fake_run(0, head_stdout="Content-Length: 4096\r\n", get_returncode=22))
    with pytest.raises(RuntimeError, match="spoke could not serve"):
        prefetch.prefetch_node_discovery_initrd(node, "dev-1")


def test_discovery_prefetch_downloads_when_the_spoke_serves_it(tmp_path, monkeypatch):
    node, target = _prefetch_env(tmp_path, monkeypatch)
    calls = _fake_run(0, head_stdout="Content-Length: 9\r\n")
    monkeypatch.setattr(prefetch, "run", calls)
    out = _capture_log(monkeypatch)

    assert prefetch.prefetch_node_discovery_initrd(node, "dev-1") == target
    assert calls.calls[-1][-3:] == ["-o", str(target), f"http://127.0.0.1:8000/api/initrd/{target.name}"]
    assert out.getvalue() == ""


def test_discovery_prefetch_skips_the_download_on_a_verified_size_match(tmp_path, monkeypatch):
    node, target = _prefetch_env(tmp_path, monkeypatch)
    target.write_bytes(b"123456789")
    calls = _fake_run(0, head_stdout="Content-Length: 9\r\n")
    monkeypatch.setattr(prefetch, "run", calls)

    assert prefetch.prefetch_node_discovery_initrd(node, "dev-1") == target
    assert target.read_bytes() == b"123456789"
    assert len(calls.calls) == 1


def test_discovery_prefetch_wraps_spoke_failure_with_context(tmp_path, monkeypatch):
    """A spoke build failure becomes a clear RuntimeError naming the image + url (surfaced to the UI)."""
    state = types.SimpleNamespace(state=types.SimpleNamespace(boot_artifact_root=tmp_path))
    monkeypatch.setattr(prefetch, "get_settings", lambda: state)
    monkeypatch.setattr(prefetch, "zone_endpoint", lambda _o=0: "http://127.0.0.1:8000")

    def boom(url, dest, curl=None):
        raise CalledProcessError(22, "curl")

    monkeypatch.setattr(prefetch, "fetch_if_missing", boom)
    node = types.SimpleNamespace(name="cpu-1", arch="arm64")
    with pytest.raises(RuntimeError, match="spoke could not serve"):
        prefetch.prefetch_node_discovery_initrd(node, "dev-1")


def _fleet_one_zone():
    node = types.SimpleNamespace(name="cpu-1", arch="x86_64", zone="sim-zone")
    return types.SimpleNamespace(nodes=[node], zone_port_ordinal=lambda _z: 0)


def test_wait_for_spoke_returns_as_soon_as_the_inventory_answers(monkeypatch):
    monkeypatch.setattr(prefetch, "zone_endpoint", lambda _o=0: "http://127.0.0.1:8000")
    calls = []
    monkeypatch.setattr(prefetch, "_spoke_answers", lambda url: calls.append(url) or True)
    slept: list[int] = []
    monkeypatch.setattr(prefetch.time, "sleep", lambda d: slept.append(d))

    assert prefetch.wait_for_spoke(_fleet_one_zone()) is True
    assert len(calls) == 1
    assert slept == []


def test_wait_for_spoke_gives_up_and_names_the_spoke(monkeypatch):
    out = _capture_log(monkeypatch)
    monkeypatch.setattr(prefetch, "zone_endpoint", lambda _o=0: "http://127.0.0.1:8000")

    monkeypatch.setattr(prefetch, "_spoke_answers", lambda _url: False)
    monkeypatch.setattr(prefetch.time, "sleep", lambda _d: None)

    assert prefetch.wait_for_spoke(_fleet_one_zone(), tries=3, delay=1) is False
    assert "is the spoke process running?" in out.getvalue()


def test_unreachable_spoke_reports_the_spoke_not_the_asset_origin(monkeypatch):
    out = _capture_log(monkeypatch)
    monkeypatch.setattr(prefetch, "zone_endpoint", lambda _o=0: "http://127.0.0.1:8000")

    def boom(_url):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(prefetch, "_fetch_inventory", boom)

    prefetch.assert_discovery_images_served(_fleet_one_zone())

    text = out.getvalue()
    assert "the spoke is not answering" in text
    assert "DISCOVERY_BASE_URL" not in text


def test_spoke_liveness_probe_does_not_use_the_retrying_curl(monkeypatch):
    seen: list[list[str]] = []

    def fake(*cmd, check: bool = True, capture: bool = False, **kw):
        seen.append([str(c) for c in cmd])
        return subprocess.CompletedProcess(seen[-1], 7, stdout="", stderr="")

    monkeypatch.setattr(prefetch, "run", fake)

    assert prefetch._spoke_answers("http://127.0.0.1:8000/api/discovery/inventory") is False
    assert "--retry" not in seen[0]
    assert "--max-time" in seen[0] and seen[0][seen[0].index("--max-time") + 1] == "3"
