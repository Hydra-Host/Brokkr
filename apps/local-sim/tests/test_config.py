from __future__ import annotations

from local.config import Settings, get_settings

_VALID_ZONE_ID = "00000000-0000-0000-0000-aaaaaaaa0001"


def test_zone_id_defaults_to_canonical_sim_uuid(monkeypatch):
    monkeypatch.delenv("BRIDGE_ZONE_ID", raising=False)
    assert Settings().bridge.zone_id == "00000000-0000-0000-0000-111111111111"


def test_defaults_apply_when_env_empty():
    s = Settings()
    assert s.bridge.endpoint == "http://127.0.0.1:8000"
    assert s.bridge.zone_id == _VALID_ZONE_ID
    assert s.sim.zone_name == "sim-zone"
    assert s.sim.netbox_site_id == 1
    assert s.sim.netbox_location_id == 1
    assert s.sim.org_tenant_id == "1"
    assert s.sim.bridge_name == "sim-bridge"
    assert s.sim.nameservers == ("1.1.1.1", "8.8.8.8")
    assert s.runtime.cache_ttl_seconds == 86400
    assert s.stores.hub_database_url.startswith("postgresql://")
    assert s.stores.bridge_redis_url == "redis://127.0.0.1:6379"
    assert s.paths.build_base_image == "ubuntu:24.04"


def test_bridge_endpoint_env_override(monkeypatch):
    monkeypatch.setenv("BRIDGE_ENDPOINT", "http://172.17.0.1:8000")
    assert Settings().bridge.endpoint == "http://172.17.0.1:8000"


def test_state_derived_paths_compose_from_root(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    s = Settings()
    assert s.state.root == tmp_path
    assert s.state.boot_artifact_root == tmp_path / "boot"
    assert s.state.iso_cache_root == tmp_path / "cache"
    assert s.state.overlay_root == tmp_path / "disks/overlays"
    assert s.state.render_dir == tmp_path / "state/rendered"
    assert s.state.run_dir == tmp_path / "state/run"
    assert s.state.log_dir == tmp_path / "state/logs"
    assert s.state.auth_keys_file == tmp_path / "cache/authorized_keys"
    assert s.state.nvram_root == tmp_path / "nvram"
    assert s.state.socket_vmnet_sock_for("gpu-1") == tmp_path / "state/run/socket_vmnet.gpu-1.sock"
    assert s.state.socket_vmnet_pid_for("gpu-1") == tmp_path / "state/run/socket_vmnet.gpu-1.pid"
    assert s.state.socket_vmnet_log_for("gpu-1") == tmp_path / "state/logs/socket_vmnet.gpu-1.log"
    assert s.state.ipmi_sim_dir_for("gpu-1") == tmp_path / "state/ipmi-sim/gpu-1"
    assert s.state.sushy_conf_dir == tmp_path / "state/run/sushy"


def test_sim_int_coercion_from_string_env(monkeypatch):
    monkeypatch.setenv("SIM_NETBOX_SITE_ID", "200")
    s = Settings()
    assert s.sim.netbox_site_id == 200
    assert isinstance(s.sim.netbox_site_id, int)


def test_paths_local_prefix(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_TEMPLATES_DIR", str(tmp_path / "tmpl"))
    monkeypatch.setenv("LOCAL_PYTHON_BIN", str(tmp_path / "bin"))
    monkeypatch.setenv("LOCAL_LIBVIRT_URI", "qemu:///system")
    monkeypatch.setenv("LOCAL_QEMU_EMULATOR", str(tmp_path / "bin" / "qemu-system-aarch64"))
    monkeypatch.setenv("LOCAL_IPMI_SIM_BIN", str(tmp_path / "opt" / "ipmi_sim"))
    s = Settings()
    assert s.paths.templates_dir == tmp_path / "tmpl"
    assert s.paths.python_bin == tmp_path / "bin"
    assert s.paths.libvirt_uri == "qemu:///system"
    assert s.paths.qemu_emulator == tmp_path / "bin" / "qemu-system-aarch64"
    assert s.paths.ipmi_sim == tmp_path / "opt" / "ipmi_sim"
    assert s.paths.sushy == tmp_path / "bin" / "sushy-emulator"


def test_sim_nameservers_env_parses_comma_separated(monkeypatch):
    monkeypatch.setenv("SIM_NAMESERVERS", "9.9.9.9,1.0.0.1")
    assert Settings().sim.nameservers == ("9.9.9.9", "1.0.0.1")


def test_bridge_ssh_key_path_defaults_to_bridge_api_pubkey():
    from pathlib import Path

    assert Settings().bridge.ssh_key_path == Path.home() / ".config/bridge-api/ssh-key.pub"


def test_bridge_brokkr_live_img_path(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_PERSISTENT_STORAGE", str(tmp_path))
    s = Settings()
    assert s.bridge.initrd_builds_dir == tmp_path / "initrd-builds"
    assert s.bridge.brokkr_live_img == tmp_path / "initrd-builds" / "brokkr-live.img"


def test_stores_groups_postgres_and_redis(monkeypatch):
    monkeypatch.setenv("HUB_DATABASE_URL", "postgresql://test:pw@h:5432/db")
    monkeypatch.setenv("BRIDGE_REDIS_URL", "redis://test:6379/0")
    s = Settings()
    assert s.stores.hub_database_url == "postgresql://test:pw@h:5432/db"
    assert s.stores.bridge_redis_url == "redis://test:6379/0"


def test_hub_repo_path_expands_leading_tilde(monkeypatch):
    from pathlib import Path

    monkeypatch.setenv("HUB_REPO_PATH", "~/some/where/brokkr-app")
    assert Settings().bridge.api_repo == Path.home() / "some/where/brokkr-app"


def test_local_state_expands_leading_tilde(monkeypatch):
    from pathlib import Path

    monkeypatch.setenv("LOCAL_STATE", "~/some/state/root")
    assert Settings().state.root == Path.home() / "some/state/root"


def test_hub_repo_path_expands_home_var(monkeypatch):
    from pathlib import Path

    monkeypatch.setenv("HUB_REPO_PATH", "$HOME/some/where/brokkr-app")
    assert Settings().bridge.api_repo == Path.home() / "some/where/brokkr-app"


def test_local_state_expands_home_var(monkeypatch):
    from pathlib import Path

    monkeypatch.setenv("LOCAL_STATE", "$HOME/some/state/root")
    assert Settings().state.root == Path.home() / "some/state/root"


def test_api_repo_default_derives_from_checkout(monkeypatch):
    from pathlib import Path

    import local.config as config_mod

    monkeypatch.delenv("HUB_REPO_PATH", raising=False)
    api_repo = Settings().bridge.api_repo

    assert "hydra-repos" not in api_repo.parts
    assert api_repo.is_dir()
    expected_root = Path(config_mod.__file__).resolve().parents[4]
    assert api_repo == expected_root
    assert (api_repo / "apps").is_dir()


def test_api_repo_hub_repo_path_overrides_default(monkeypatch):
    from pathlib import Path

    monkeypatch.setenv("HUB_REPO_PATH", "/some/other/brokkr-app")
    assert Settings().bridge.api_repo == Path("/some/other/brokkr-app")


def test_get_settings_is_cached():
    a = get_settings()
    b = get_settings()
    assert a is b
    get_settings.cache_clear()
    c = get_settings()
    assert c is not a
