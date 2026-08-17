"""Tests for ``local.host_os.macos_major``."""

from __future__ import annotations

import pytest
from local import host_os


@pytest.fixture(autouse=True)
def _clear_caches():
    """Clear lru_cache between tests so monkeypatches take effect."""
    host_os.host_os.cache_clear()
    host_os.macos_major.cache_clear()
    yield
    host_os.host_os.cache_clear()
    host_os.macos_major.cache_clear()


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("26.5.2", 26),
        ("26", 26),
        ("15.0", 15),
    ],
)
def test_macos_major_valid_version(monkeypatch, version, expected):
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.mac_ver", lambda: (version, ("", "", ""), ""))
    assert host_os.macos_major() == expected


def test_macos_major_empty_version(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.mac_ver", lambda: ("", ("", "", ""), ""))
    assert host_os.macos_major() is None


def test_macos_major_non_macos(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    assert host_os.macos_major() is None
