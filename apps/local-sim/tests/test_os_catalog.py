from __future__ import annotations

import local.config as cfg
import local.seed.os_catalog as os_catalog
import pytest

_INDEX_URL = "https://assets.test/os-layers/releases/latest"
_MANIFEST_URL = "https://assets.test/os-layers/releases/7/manifest.json"


@pytest.fixture
def index_url(monkeypatch):
    monkeypatch.setenv("SIM_OS_LAYERS_MANIFEST_INDEX_URL", _INDEX_URL)
    cfg.get_settings.cache_clear()
    return _INDEX_URL


def _stub_fetches(monkeypatch, docs):
    seen = []

    def fake(url):
        seen.append(url)
        return docs[url]

    monkeypatch.setattr(os_catalog, "http_get_json", fake)
    return seen


def test_fetch_manifest_returns_direct_manifest(index_url, monkeypatch):
    manifest = {"layers": [{"name": "ubuntu-2404"}]}
    seen = _stub_fetches(monkeypatch, {index_url: manifest})
    assert os_catalog.fetch_manifest() == manifest
    assert seen == [index_url]


def test_fetch_manifest_follows_index_url(index_url, monkeypatch):
    seen = _stub_fetches(monkeypatch, {index_url: {"url": _MANIFEST_URL}, _MANIFEST_URL: {"layers": []}})
    assert os_catalog.fetch_manifest() == {"layers": []}
    assert seen == [index_url, _MANIFEST_URL]


def test_fetch_manifest_rejects_doc_with_neither_key(index_url, monkeypatch):
    _stub_fetches(monkeypatch, {index_url: {"version": "7"}})
    with pytest.raises(RuntimeError, match="neither a manifest"):
        os_catalog.fetch_manifest()


def test_try_fetch_manifest_passes_through_a_reachable_manifest(index_url, monkeypatch):
    manifest = {"layers": [{"name": "ubuntu-2404"}]}
    _stub_fetches(monkeypatch, {index_url: manifest})
    assert os_catalog.try_fetch_manifest() == manifest


def test_try_fetch_manifest_returns_none_when_unreachable(index_url, monkeypatch):
    def boom(url):
        raise RuntimeError(f"failed to fetch {url}")

    monkeypatch.setattr(os_catalog, "http_get_json", boom)
    assert os_catalog.try_fetch_manifest() is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("SINGLE_SELECT", "SINGLE_SELECT"),
        ("MULTI_SELECT", "MULTI_SELECT"),
        ("legacy", "SINGLE_SELECT"),
        (None, "SINGLE_SELECT"),
    ],
)
def test_normalize_selection_type(value, expected):
    assert os_catalog.normalize_selection_type(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("base", "BASE"),
        ("component", "COMPONENT"),
        ("legacy", "LEGACY"),
        ("internal", "INTERNAL"),
        ("live", "LIVE"),
    ],
)
def test_normalize_kind(value, expected):
    assert os_catalog.normalize_kind(value) == expected


def test_http_get_json_wraps_transport_failure(monkeypatch):
    def boom(req, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(os_catalog.urllib.request, "urlopen", boom)
    with pytest.raises(RuntimeError, match="failed to fetch"):
        os_catalog.http_get_json(_INDEX_URL)
