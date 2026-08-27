"""Tests for ``local.host_os.macos_major``, ``detect_accel`` and ``domain_type``."""

from __future__ import annotations

import local.config as cfg
import pytest
from local import host_os, process_utils


@pytest.fixture(autouse=True)
def _clear_caches():
    """Clear lru_cache between tests so monkeypatches take effect."""
    for fn in (host_os.host_os, host_os.macos_major, host_os.detect_accel):
        fn.cache_clear()
    yield
    for fn in (host_os.host_os, host_os.macos_major, host_os.detect_accel):
        fn.cache_clear()


@pytest.fixture
def probe(monkeypatch):
    def _install(results: dict[str, bool]) -> list[tuple]:
        calls: list[tuple] = []

        def fake(*cmd):
            calls.append(cmd)
            return results.get(cmd[cmd.index("--virttype") + 1], False)

        monkeypatch.setattr(process_utils, "cmd_succeeds", fake)
        return calls

    return _install


def _force(monkeypatch, value: str) -> None:
    monkeypatch.setenv("LOCAL_ACCEL", value)
    cfg.get_settings.cache_clear()


def test_detect_accel_falls_back_to_kvm_when_virsh_is_absent(monkeypatch):
    _force(monkeypatch, "auto")
    monkeypatch.setattr("platform.system", lambda: "Linux")

    def missing(*_cmd):
        raise FileNotFoundError(2, "No such file or directory", "virsh")

    monkeypatch.setattr(process_utils, "cmd_succeeds", missing)
    assert host_os.detect_accel() == "kvm"


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


def test_detect_accel_returns_hvf_on_macos_without_probing(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    _force(monkeypatch, "auto")
    calls = probe({})
    assert host_os.detect_accel() == "hvf"
    assert calls == []


def test_detect_accel_returns_kvm_when_the_kvm_probe_answers(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "auto")
    probe({"kvm": True, "qemu": True})
    assert host_os.detect_accel() == "kvm"


def test_detect_accel_returns_tcg_when_only_the_qemu_probe_answers(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "auto")
    probe({"kvm": False, "qemu": True})
    assert host_os.detect_accel() == "tcg"


def test_detect_accel_returns_kvm_when_libvirt_is_unreachable(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "auto")
    probe({})
    assert host_os.detect_accel() == "kvm"


def test_detect_accel_probes_once_per_process(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "auto")
    calls = probe({"kvm": True})
    host_os.detect_accel()
    host_os.detect_accel()
    assert len(calls) == 1


def test_detect_accel_honors_a_forced_setting_without_probing(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "tcg")
    calls = probe({"kvm": True})
    assert host_os.detect_accel() == "tcg"
    assert calls == []


def test_detect_accel_probe_names_the_configured_emulator(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "auto")
    calls = probe({"kvm": True})
    host_os.detect_accel()
    assert "/nonexistent/ci/qemu-system" in [str(c) for c in calls[0]]
    assert "domcapabilities" in calls[0]


@pytest.mark.parametrize(("accel", "expected"), [("tcg", "qemu"), ("kvm", "kvm"), ("hvf", "hvf")])
def test_domain_type_maps_tcg_to_qemu(accel, expected):
    assert host_os.domain_type(accel) == expected


@pytest.mark.parametrize("forced", ["tcg", "kvm", "hvf"])
def test_accel_forced_is_true_for_an_explicit_setting(monkeypatch, forced):
    _force(monkeypatch, forced)
    assert host_os.accel_forced() is True


def test_accel_forced_is_false_when_the_accelerator_is_auto_detected(monkeypatch):
    _force(monkeypatch, "auto")
    assert host_os.accel_forced() is False


def test_accel_forced_never_probes(monkeypatch, probe):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    _force(monkeypatch, "auto")
    calls = probe({"kvm": True})
    assert host_os.accel_forced() is False
    assert calls == []
