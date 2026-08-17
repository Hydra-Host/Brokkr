from __future__ import annotations

import os

import local.config as cfg
import pytest

_VALID_ZONE_ID = "00000000-0000-0000-0000-aaaaaaaa0001"

_HOST_PATH_STUBS = {
    "LOCAL_QEMU_EMULATOR": "/nonexistent/ci/qemu-system",
    "LOCAL_EDK2_CODE_PATH": "/nonexistent/ci/edk2-code.fd",
    "LOCAL_EDK2_VARS_TEMPLATE_PATH": "/nonexistent/ci/edk2-vars.fd",
}

_LEAKABLE_PREFIXES = ("BRIDGE_", "SIM_", "LOCAL_", "LOCA_", "HUB_")
_LEAKABLE_EXACT = ("CACHE_TTL_SECONDS",)

_SETTINGS_CLASSES = (
    cfg.Settings,
    cfg.PathsSettings,
    cfg.StateSettings,
    cfg.BridgeSettings,
    cfg.HubSettings,
    cfg.SimSettings,
    cfg.StoresSettings,
    cfg.RuntimeSettings,
)


@pytest.fixture(autouse=True)
def isolate_config(monkeypatch):
    for klass in _SETTINGS_CLASSES:
        new_config = dict(klass.model_config)
        new_config["env_file"] = None
        monkeypatch.setattr(klass, "model_config", new_config)

    for key in list(os.environ):
        if key in _LEAKABLE_EXACT or any(key.startswith(p) for p in _LEAKABLE_PREFIXES):
            monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("BRIDGE_ZONE_ID", _VALID_ZONE_ID)
    for key, val in _HOST_PATH_STUBS.items():
        monkeypatch.setenv(key, val)

    cfg.get_settings.cache_clear()
    yield
    cfg.get_settings.cache_clear()
