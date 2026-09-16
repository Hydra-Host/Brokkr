from __future__ import annotations

import importlib.util
import os
import re
from pathlib import Path

import local.config as cfg
import pytest
from local.derived import sim_device_uuid
from local.sqlemit import emit_upsert, ident, q
from local.zones import bridge_device_uuid
from pydantic import ValidationError

_SQL_SEED = Path(__file__).resolve().parents[1] / "sql-seed"
_FIXTURE_FLEET = Path(__file__).resolve().parent / "fixtures" / "fleet.yml"
_FIXTURE_FLEET_MULTI = Path(__file__).resolve().parent / "fixtures" / "fleet-multi.yml"


def _load(filename: str):
    mod_name = filename.replace("-", "_").removesuffix(".py")
    spec = importlib.util.spec_from_file_location(mod_name, _SQL_SEED / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def fixture_fleet(monkeypatch):
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(_FIXTURE_FLEET))
    cfg.get_settings.cache_clear()
    return _FIXTURE_FLEET


@pytest.fixture
def fixture_fleet_multi(monkeypatch):
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(_FIXTURE_FLEET_MULTI))
    cfg.get_settings.cache_clear()
    return _FIXTURE_FLEET_MULTI


def test_zone_generator_emits_zone_and_bridge(fixture_fleet):
    sql = _load("45-zone.py").generate()
    assert 'INSERT INTO "Zone"' in sql
    assert '"uuidSuffix"' in sql
    assert "'sim-zone'" in sql
    assert "'sim-zone-maintenance'" in sql
    assert "00000000-0000-0000-0000-000000000000" in sql
    # Fleet zone (PRIMARY+SHIPPING) + maintenance fixture (PRIMARY only).
    assert sql.count('INSERT INTO "ZoneAddress"') == 2
    assert "'PRIMARY'::\"ZoneAddressType\"" in sql
    assert "'SHIPPING'::\"ZoneAddressType\"" in sql
    assert sql.count('INSERT INTO "Contact"') == 2
    assert "'Main'::\"ZoneContactType\"" in sql
    assert "'Technical'::\"ZoneContactType\"" in sql
    # Two historical windows on the fleet zone + one active on the fixture zone.
    assert sql.count('INSERT INTO "ZoneMaintenance"') == 3
    assert sql.count('    "disabledAt", "disabledBy", "createdAt", "updatedAt"') == 3
    assert sql.count('"disabledAt" = EXCLUDED."disabledAt"') == 3
    assert "NULL, NULL, NOW() - INTERVAL '2 hours', NOW()" in sql
    assert "Cooling plant outage" in sql
    assert "brokkr@brokkr.local" in sql
    assert 'INSERT INTO "Bridge"' in sql
    assert "'sim-bridge'" in sql
    assert "00000000-0000-0000-0000-000000008000" in sql
    assert "ON CONFLICT" in sql
    assert '"organizationId"' in sql
    assert sql.count("'VIRTUAL'::\"InterfaceType\"") == 1
    assert sql.count("'IPMI_BMC'::\"InterfaceType\"") == 1
    assert "'vip0'" in sql
    assert "192.168.200.2/24" in sql
    assert "192.168.200.3/24" in sql
    assert "192.168.105.2/24" in sql


def test_operator_api_key_generator_emits_hashed_key(monkeypatch):
    monkeypatch.delenv("HUB_OPERATOR_API_KEY", raising=False)
    cfg.get_settings.cache_clear()
    mod = _load("35-operator-api-key.py")
    sql = mod.generate()
    assert 'INSERT INTO "apikey"' in sql
    assert mod.DEFAULT_LOCAL_KEY not in sql.replace(mod.DEFAULT_LOCAL_KEY[:6], "", 1)
    assert mod.hashed_key(mod.DEFAULT_LOCAL_KEY) in sql
    assert "NOT EXISTS" in sql


def test_operator_api_key_generator_honors_env_override(monkeypatch):
    monkeypatch.setenv("HUB_OPERATOR_API_KEY", "brk_custom_key")
    cfg.get_settings.cache_clear()
    mod = _load("35-operator-api-key.py")
    sql = mod.generate()
    assert mod.hashed_key("brk_custom_key") in sql


def test_devices_generator_emits_one_device_per_node_idempotently(fixture_fleet):
    import yaml

    fleet = yaml.safe_load(fixture_fleet.read_text())
    expected = len(fleet["nodes"])
    sql = _load("50-devices.py").generate()
    assert sql.count('INSERT INTO "Device"') == expected
    assert "ON CONFLICT (id)" in sql
    assert sim_device_uuid(0) in sql
    assert "'Server'::\"DeviceRole\"" in sql
    assert '"supplierId"' in sql
    assert '"supplierId", "organizationId"' not in sql
    assert 'INSERT INTO "StorageDrive"' in sql
    assert sql.lstrip().startswith("-- GENERATED")
    assert sql.rstrip().endswith("COMMIT;")


def test_devices_generator_seeds_sol_config_for_serial_console(fixture_fleet):
    import yaml

    fleet = yaml.safe_load(fixture_fleet.read_text())
    expected = len(fleet["nodes"])
    expected_port = "ttyAMA0" if cfg.get_settings().sim.host_arch == "arm64" else "ttyS0"
    sql = _load("50-devices.py").generate()
    assert sql.count('INSERT INTO "DeviceSolConfig"') == expected
    assert '"optimalPort"' in sql and f"'{expected_port}'" in sql
    assert "115200" in sql
    assert 'ON CONFLICT ("deviceId") DO UPDATE' in sql


def test_devices_generator_seeds_hardware_inventory(fixture_fleet):
    import yaml

    fleet = yaml.safe_load(fixture_fleet.read_text())
    expected = len(fleet["nodes"])
    cpus_per = int(fleet["defaults"]["cpus"])
    sql = _load("50-devices.py").generate()
    assert sql.count('INSERT INTO "Cpu"') == expected * cpus_per
    assert sql.count('INSERT INTO "MemoryConfig"') == expected
    assert sql.count('INSERT INTO "DeviceFirmware"') == expected
    assert sql.count('INSERT INTO "Gpu"') == expected
    assert '"systemSerial"' in sql and '"chassisSerial"' in sql
    assert "serial = EXCLUDED.serial" in sql
    assert '"baseboardSerial" = EXCLUDED."baseboardSerial"' in sql
    assert "'NVIDIA GeForce RTX 4090'" in sql
    assert "'BIOS'::\"FirmwareType\"" in sql and "'BMC'::\"FirmwareType\"" in sql
    assert "'ib0'" in sql and "'INFINIBAND'::\"InterfaceLinkType\"" in sql
    assert "virtio_net" in sql and "speed" in sql


def test_devices_generator_serial_wwn_derive_from_ipmi_mac(fixture_fleet):
    sql = _load("50-devices.py").generate()
    assert "SIM525400BC0001" in sql
    assert "0x500525400bc00010" in sql
    assert "SIM_SSD_40GB" in sql


def test_devices_generator_tags_every_vm_device_with_the_discovery_light_tag(fixture_fleet):
    import yaml

    fleet = yaml.safe_load(fixture_fleet.read_text())
    sql = _load("50-devices.py").generate()
    assert sql.count('INSERT INTO "Tag"') == 1
    assert "'discovery-light', 'discovery-light'" in sql
    assert sql.count('INSERT INTO "TagAssignment"') == len(fleet["nodes"])
    assert sql.count("'DEVICE'::\"TagObjectType\"") == len(fleet["nodes"])
    assert sql.index('INSERT INTO "Tag"') < sql.index('INSERT INTO "TagAssignment"')


def test_devices_generator_attaches_reachable_ip_to_data_nic(fixture_fleet):
    sql = _load("50-devices.py").generate()
    assert "'192.168.200.10/24'::inet" in sql
    assert "name = 'eth0'" in sql


def test_devices_generator_frees_the_address_before_reattaching_it(fixture_fleet):
    sql = _load("50-devices.py").generate()
    org = 'SELECT "organizationId" FROM "Zone"'
    clear = [line for line in sql.splitlines() if line.startswith("WHERE address =") and org in line]
    assert any("'192.168.200.10/24'::inet" in line for line in clear)
    insert = sql.index("'192.168.200.10/24'::inet, 'ACTIVE'")
    assert sql.index("""WHERE address = '192.168.200.10/24'::inet""") < insert


def test_devices_generator_frees_only_the_key_the_constraint_uses(fixture_fleet):
    from local.seed.interfaces import emit_ip_address_clear

    stmt = emit_ip_address_clear("192.168.200.10/24", "'org'")
    assert '"vrfId" IS NULL' in stmt
    assert '"deletedAt" IS NULL' in stmt


def test_devices_generator_netplan_carries_fleet_prefix_length(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/25, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    sql = _load("50-devices.py").generate()
    assert "addresses: [192.168.200.10/25]" in sql
    assert "192.168.200.10/24" not in sql
    assert "'192.168.200.10/25'::inet" in sql


def test_devices_generator_honors_static_ip_and_bmc_ip_overrides(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01",\n'
        "     ip: 192.168.200.77, bmc_ip: 192.168.105.88}\n"
        '  - {name: cpu-2, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02"}\n'
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)

    sql = _load("50-devices.py").generate()
    assert "'192.168.200.77/24'::inet" in sql
    assert "addresses: [192.168.200.77/24]" in sql
    assert "'192.168.105.88'::inet" in sql
    assert "192.168.200.10" not in sql
    assert "192.168.105.10" not in sql
    assert "'192.168.200.11/24'::inet" in sql
    assert "'192.168.105.11'::inet" in sql


def test_devices_generator_storage_follows_per_node_disk_gb(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01", disk_gb: 120}\n'
        '  - {name: cpu-2, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02"}\n'
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)

    sql = _load("50-devices.py").generate()
    assert "SIM_SSD_120GB" in sql
    assert str(120 * 1024 * 1024 * 1024) in sql
    assert "SIM_SSD_40GB" in sql
    assert str(40 * 1024 * 1024 * 1024) in sql


def test_commissioning_generator_honors_bmc_ip_override(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: commission-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01",\n'
        "     seed_as_server: false, bmc_ip: 192.168.105.66}\n"
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)

    sql = _load("51-commissioning-devices.py").generate()
    assert "'192.168.105.66'::inet" in sql
    assert "192.168.105.10" not in sql


_BM_NET_DEFAULTS = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
)

_BM_ONLY_BLOCK = (
    "nodes: []\n"
    "baremetal:\n"
    "  iface: enp35s0\n"
    "  iface_ip: 198.51.100.10\n"
    "  arch: amd64\n"
    "  nodes:\n"
    '    - {name: bench-1, pxe_mac: "00:00:5e:00:53:b4", bmc_mac: "00:00:5e:00:53:b5", bmc_ip: 198.51.100.250}\n'
)

_TWO_PLANE_FLEET = (
    _BM_NET_DEFAULTS + "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
    "baremetal:\n"
    "  iface: enp35s0\n"
    "  iface_ip: 198.51.100.10\n"
    "  arch: amd64\n"
    "  nodes:\n"
    '    - {name: bench-1, pxe_mac: "00:00:5e:00:53:b4", bmc_mac: "00:00:5e:00:53:b5", bmc_ip: 198.51.100.250}\n'
)


@pytest.mark.parametrize("gen_file", ["50-devices.py", "55-dcim.py"])
def test_device_generators_noop_on_an_empty_vm_roster_beside_a_machine(gen_file, tmp_path, monkeypatch):
    (tmp_path / "fleet.yml").write_text(_BM_NET_DEFAULTS + _BM_ONLY_BLOCK)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(tmp_path / "fleet.yml"))
    cfg.get_settings.cache_clear()
    sql = _load(gen_file).generate()
    assert "no VM nodes" in sql
    assert "BEGIN;" not in sql


@pytest.mark.parametrize("gen_file", ["50-devices.py", "55-dcim.py"])
def test_device_generators_noop_when_no_plane_is_on(gen_file, tmp_path, monkeypatch):
    (tmp_path / "fleet.yml").write_text(_BM_NET_DEFAULTS + "nodes: []\n")
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(tmp_path / "fleet.yml"))
    cfg.get_settings.cache_clear()
    sql = _load(gen_file).generate()
    assert "no VM nodes" in sql
    assert "BEGIN;" not in sql


def test_devices_generator_seeds_the_vm_roster_beside_a_machine(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _TWO_PLANE_FLEET)
    sql = _load("50-devices.py").generate()
    assert sql.count('INSERT INTO "Device"') == 1
    assert "'cpu-1'" in sql
    assert "bench-1" not in sql


def test_devices_generator_defaults_all_flat(fixture_fleet):
    sql = _load("50-devices.py").generate()
    assert sql.count("net=Public") == 4
    assert "net=NAT" not in sql
    assert sql.count('"networkType"') >= 1
    assert '"natInsideId"' not in sql


def test_devices_generator_network_type_override_forces_nat(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01", network_type: nat}\n'
        '  - {name: cpu-2, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02"}\n'
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    sql = _load("50-devices.py").generate()
    assert sql.count("net=NAT") == 1 and sql.count("net=Public") == 1
    assert sql.count('"natInsideId"') == 1
    assert sql.count("'198.51.100.10/32'") == 2
    assert sql.count("'198.51.100.11/32'") == 1


def test_commissioning_generator_deletes_filter_soft_deleted_interfaces(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: commission-1, ipmi_mac: "52:54:00:bc:00:01",'
        ' data_mac: "52:54:00:da:00:01", seed_as_server: false}\n'
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    sql = _load("51-commissioning-devices.py").generate()
    deletes = re.findall(r'DELETE FROM "IpAddress" WHERE "interfaceId"[^;]+;', sql, re.S)
    assert len(deletes) == 2
    for d in deletes:
        assert '"interfaceId" IN' in d
        assert '"deletedAt" IS NULL' in d
    assert '"interfaceId" =' not in sql
    inserts = re.findall(r'INSERT INTO "IpAddress"[^;]+FROM "Interface"[^;]+;', sql, re.S)
    assert len(inserts) >= 1
    for ins in inserts:
        assert '"deletedAt" IS NULL' in ins


def test_unassigned_devices_generator_emits_two_role_null_planned(fixture_fleet):
    """Static picker devices for admin Create Switch/Server — role=NULL, PLANNED,
    zone 0 + hydra org, and ON CONFLICT only refreshes while still unassigned."""
    mod = _load("53-unassigned-devices.py")
    sql = mod.generate()
    assert sql.count('INSERT INTO "Device"') == 2
    assert "'unassigned-1'" in sql and "'unassigned-2'" in sql
    assert sql.count("NULL, 'Baremetal'::\"DeviceType\"") == 2
    assert sql.count("'PLANNED'::\"DeviceStatus\"") == 2
    assert "00000000-0000-0000-0000-111111111111" in sql  # zone 0
    assert "00000000-0000-0000-0000-000000000000" in sql  # hydra org
    assert 'WHERE "Device".role IS NULL' in sql
    for label in ("device:unassigned-1", "device:unassigned-2"):
        assert mod.device_id(label) in sql


def test_zone_generator_multi_zone_emits_n_zones_and_k_bridges(fixture_fleet_multi):
    sql = _load("45-zone.py").generate()
    # Two fleet zones + the admin ops maintenance fixture zone.
    assert sql.count('INSERT INTO "Zone"') == 3
    assert "00000000-0000-0000-0000-111111111111" in sql
    assert "00000000-0000-0000-0000-111111111112" in sql
    assert "'sim-zone-maintenance'" in sql
    assert sql.count('INSERT INTO "Bridge"') == 3
    for name in ("'sim-bridge'", "'sim-bridge-den-1'", "'sim-bridge-den-1-1'"):
        assert name in sql
    for ordinal in (8000, 8001, 8002):
        assert bridge_device_uuid(ordinal) in sql
    org = "00000000-0000-0000-0000-000000000000"
    assert org in sql
    assert sql.count("'VIRTUAL'::\"InterfaceType\"") == 3
    assert sql.count("'IPMI_BMC'::\"InterfaceType\"") == 3
    assert "192.168.200.2/24" in sql
    assert "192.168.200.6/24" in sql
    assert "192.168.105.4/24" in sql


def test_devices_generator_assigns_per_node_zone(fixture_fleet_multi):
    import re

    sql = _load("50-devices.py").generate()
    zone_by_node = dict(re.findall(r"-- (\S+) .*zone=(\S+)", sql))
    assert zone_by_node["cpu-1"] == "00000000-0000-0000-0000-111111111111"
    assert zone_by_node["cpu-2"] == "00000000-0000-0000-0000-111111111111"
    assert zone_by_node["gpu-1"] == "00000000-0000-0000-0000-111111111112"
    assert zone_by_node["gpu-2"] == "00000000-0000-0000-0000-111111111112"


def test_dcim_generator_decorates_servers_and_peers(fixture_fleet):
    import yaml

    n = len(yaml.safe_load(fixture_fleet.read_text())["nodes"])
    sql = _load("55-dcim.py").generate()

    assert sql.lstrip().startswith("-- GENERATED")
    assert sql.rstrip().endswith("COMMIT;")
    assert "ON CONFLICT" in sql

    assert sql.count('INSERT INTO "Rack"') == 1
    assert sql.count('INSERT INTO "DeviceRackAssignment"') == n + 4
    assert sim_device_uuid(0) in sql
    assert 'UPDATE "Device" SET "deviceModelId"' in sql
    for peer in ("sim-tor-1", "sim-pdu-1", "sim-conserver-1", "sim-patch-1"):
        assert f"'{peer}'" in sql

    for term in (
        "INTERFACE",
        "POWER_PORT",
        "POWER_OUTLET",
        "CONSOLE_PORT",
        "CONSOLE_SERVER_PORT",
        "FRONT_PORT",
        "REAR_PORT",
    ):
        assert f"'{term}'::\"CableTerminationType\"" in sql
    assert sql.count('INSERT INTO "Cable"') == n * 3 + 2

    assert 'INSERT INTO "Tag"' in sql
    assert 'INSERT INTO "BgpSession"' in sql
    assert 'INSERT INTO "Circuit"' in sql
    assert "00000000-0000-0000-0000-000000000000" in sql
    assert "00000000-0000-0000-0000-111111111111" in sql


def test_dcim_generator_seeds_manufacturer_contacts(fixture_fleet):
    dcim = _load("55-dcim.py")
    sql = dcim.generate()

    assert len(dcim.MANUFACTURER_CONTACTS) == 2
    assert sql.count('INSERT INTO "Contact"') == 2
    assert sql == dcim.generate()
    assert '"zoneId" = NULL, "organizationId" = NULL' in sql
    assert '"contactType" = NULL, "isShippingContact" = FALSE, "deletedAt" = NULL' in sql
    for manufacturer, _name, title, email, _phone, _notes, _portal, _website in dcim.MANUFACTURER_CONTACTS:
        assert f"(SELECT id FROM \"Manufacturer\" WHERE name = '{manufacturer}')" in sql
        assert title in sql
        assert email in sql
        assert email.endswith("@example.test")
        assert dcim.did(f"mfr-contact:{manufacturer}:{email}") in sql


def test_dcim_generator_seeds_pdu_role_devices_with_child_rows(fixture_fleet):
    sql = _load("55-dcim.py").generate()

    for name in ("sim-pdu-a", "sim-pdu-b"):
        assert f"'{name}'" in sql
    assert sql.count('INSERT INTO "Pdu"') == 2
    assert "'PDU'::\"DeviceRole\"" in sql
    assert "'On'::\"PduPowerStatus\"" in sql
    assert "'Off'::\"PduPowerStatus\"" in sql
    assert "00000000-0000-0000-0000-000000000000" in sql


def test_dcim_generator_seeds_cdu_role_devices_with_child_rows(fixture_fleet):
    sql = _load("55-dcim.py").generate()

    for name in ("sim-cdu-a", "sim-cdu-b"):
        assert f"'{name}'" in sql
    assert sql.count('INSERT INTO "Cdu"') == 2
    assert "'CDU'::\"DeviceRole\"" in sql
    assert "'FrontToRear'::\"Airflow\"" in sql
    assert "'On'::\"CduPowerStatus\"" in sql
    assert "'Off'::\"CduPowerStatus\"" in sql


def test_dcim_generator_seeds_switch_role_devices_with_child_rows(fixture_fleet):
    sql = _load("55-dcim.py").generate()

    for name in ("sim-switch-a", "sim-switch-b"):
        assert f"'{name}'" in sql
    assert sql.count('INSERT INTO "Switch"') == 2
    assert "'Switch'::\"DeviceRole\"" in sql
    assert "'On'::\"SwitchPowerStatus\"" in sql
    assert "'Off'::\"SwitchPowerStatus\"" in sql


def test_dcim_generator_seeds_router_role_devices_with_child_rows(fixture_fleet):
    sql = _load("55-dcim.py").generate()

    for name in ("sim-router-a", "sim-router-b"):
        assert f"'{name}'" in sql
    assert sql.count('INSERT INTO "Router"') == 2
    assert "'Router'::\"DeviceRole\"" in sql
    assert "'On'::\"RouterPowerStatus\"" in sql
    assert "'Off'::\"RouterPowerStatus\"" in sql


def test_dcim_generator_seeds_rack_brush_role_devices_with_child_rows(fixture_fleet):
    sql = _load("55-dcim.py").generate()

    for name in ("sim-rackbrush-a", "sim-rackbrush-b"):
        assert f"'{name}'" in sql
    assert sql.count('INSERT INTO "RackBrush"') == 2
    assert "'RackBrush'::\"DeviceRole\"" in sql
    assert "'nylon'" in sql
    assert "'polypropylene'" in sql


def test_dcim_generator_seeds_patch_panel_role_devices_with_child_rows(fixture_fleet):
    sql = _load("55-dcim.py").generate()

    for name in ("sim-patchpanel-a", "sim-patchpanel-b"):
        assert f"'{name}'" in sql
    assert sql.count('INSERT INTO "PatchPanel"') == 2
    assert "'PatchPanel'::\"DeviceRole\"" in sql
    assert "'fiber'" in sql
    assert "'copper'" in sql


def test_dcim_generator_bgp_acl_follows_relocated_cidr(tmp_path, monkeypatch):
    fleet = (
        "network: {name: t, cidr: 10.42.0.0/24, domain: t.local, bmc_cidr: 10.43.0.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    sql = _load("55-dcim.py").generate()

    assert "10.42.0.0/24" in sql
    assert "10.43.0.0/24" in sql
    assert "192.168.200.0/24" not in sql
    assert "192.168.105.0/24" not in sql


def test_dcim_generator_scales_node_ports_but_pins_the_patch_uplinks(tmp_path, monkeypatch):
    nodes = "\n".join(
        f'  - {{name: cpu-{i}, ipmi_mac: "52:54:00:bc:00:{i:02x}", data_mac: "52:54:00:da:00:{i:02x}"}}'
        for i in range(1, 9)
    )
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        f"nodes:\n{nodes}\n"
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    sql = _load("55-dcim.py").generate()
    n = 8

    assert sql.count('INSERT INTO "Interface"') >= n + 3
    for p in range(1, n + 1):
        assert f"'swp{p}'" in sql
    assert f"'swp{n + 1}'" not in sql

    assert "'swp47'" in sql
    assert "'swp48'" in sql
    assert "sim-patch-1 FP-01 → sim-tor-1 swp47" in sql
    assert "sim-patch-1 RP-02 → sim-tor-1 swp48" in sql


def _dcim_sql(tmp_path, monkeypatch, node_names: list[str], non_server: str = "") -> str:
    nodes = "\n".join(
        f'  - {{name: {name}, ipmi_mac: "52:54:00:bc:00:{i:02x}", data_mac: "52:54:00:da:00:{i:02x}"'
        + (", seed_as_server: false}" if name == non_server else "}")
        for i, name in enumerate(node_names, start=1)
    )
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        f"nodes:\n{nodes}\n"
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)
    return _load("55-dcim.py").generate()


def _switch_port_by_cable(sql: str) -> dict[str, str]:
    return dict(re.findall(r"'([^']+) → sim-tor-1 (swp\d+)'", sql))


def test_dcim_generator_pins_each_node_to_one_switch_port(tmp_path, monkeypatch):
    big = _dcim_sql(tmp_path, monkeypatch, ["cpu-1", "cpu-2", "cpu-3", "cpu-4"])
    small = _dcim_sql(tmp_path, monkeypatch, ["cpu-1"])
    gapped = _dcim_sql(tmp_path, monkeypatch, ["cpu-1", "cpu-2", "cpu-3", "cpu-4"], non_server="cpu-2")

    for sql in (big, small, gapped):
        ports = _switch_port_by_cable(sql)
        assert ports["cpu-1 eth0"] == "swp1"
        assert ports["sim-patch-1 FP-01"] == "swp47"
        assert ports["sim-patch-1 RP-02"] == "swp48"

    assert _switch_port_by_cable(big)["cpu-4 eth0"] == "swp4"
    assert _switch_port_by_cable(gapped)["cpu-4 eth0"] == "swp4"
    assert "cpu-2 eth0" not in _switch_port_by_cable(gapped)


def test_dcim_generator_refuses_a_fleet_that_overruns_the_patch_uplinks(tmp_path, monkeypatch):
    names = [f"cpu-{i}" for i in range(1, 48)]
    with pytest.raises(ValueError, match="cannot host them all"):
        _dcim_sql(tmp_path, monkeypatch, names)

    ok = _dcim_sql(tmp_path, monkeypatch, [f"cpu-{i}" for i in range(1, 47)])
    assert "'swp46'" in ok
    assert _switch_port_by_cable(ok)["sim-patch-1 FP-01"] == "swp47"


def test_dcim_generator_never_claims_one_termination_twice(tmp_path, monkeypatch):
    for names in (["cpu-1"], ["cpu-1", "cpu-2", "cpu-3", "cpu-4"]):
        sql = _dcim_sql(tmp_path, monkeypatch, names)
        rows = re.findall(
            r"'(\w+)'::\"CableTerminationType\",\s*'([0-9a-f-]{36})', '([0-9a-f-]{36})'\)",
            sql,
        )
        claims = [(ttype, tid) for ttype, tid, _cid in rows]
        assert len(claims) == len(set(claims))


def test_dcim_generator_retires_stale_switch_cables_before_wiring(tmp_path, monkeypatch):
    sql = _dcim_sql(tmp_path, monkeypatch, ["cpu-1", "cpu-2"])

    assert 'DELETE FROM "Cable" c' in sql
    assert sql.index('DELETE FROM "Cable" c') < sql.index('INSERT INTO "CableTermination"')

    cable_ids = re.findall(r"INSERT INTO \"Cable\" \(id.*?VALUES \('([0-9a-f-]{36})'", sql, re.S)
    release = sql[sql.index('DELETE FROM "Cable" c') :].split(";")[0]
    assert cable_ids
    for cid in cable_ids:
        assert cid in release


def test_dcim_generator_rack_positions_never_collide(tmp_path, monkeypatch):
    import re

    nodes = "\n".join(
        f'  - {{name: cpu-{i}, ipmi_mac: "52:54:00:bc:00:{i:02x}", data_mac: "52:54:00:da:00:{i:02x}"}}'
        for i in range(1, 13)
    )
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        f"nodes:\n{nodes}\n"
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    sql = _load("55-dcim.py").generate()

    keys = [
        (int(pos), face)
        for pos, face in re.findall(
            r'INSERT INTO "DeviceRackAssignment".*?VALUES \([^,]+, (\d+), \'(\w+)\'',
            sql,
            re.S,
        )
    ]
    assert len(keys) == 12 + 4
    assert len(keys) == len(set(keys)), f"duplicate (position, face): {keys}"


def test_dcim_generator_peers_stay_within_rack_height(tmp_path, monkeypatch):
    import re

    nodes = "\n".join(
        f'  - {{name: cpu-{i}, ipmi_mac: "52:54:00:bc:00:{i:02x}", data_mac: "52:54:00:da:00:{i:02x}"}}'
        for i in range(1, 21)
    )
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        f"nodes:\n{nodes}\n"
    )
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(fleet)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()

    dcim = _load("55-dcim.py")
    sql = dcim.generate()

    positions = [
        int(pos)
        for pos, _face in re.findall(
            r'INSERT INTO "DeviceRackAssignment".*?VALUES \([^,]+, (\d+), \'(\w+)\'',
            sql,
            re.S,
        )
    ]
    assert positions, "no rack assignments emitted"
    assert max(positions) <= dcim.RACK_HEIGHT_U, f"assignment past rack top: {max(positions)}"
    assert f'"RackRole", {dcim.RACK_HEIGHT_U},' in sql


def test_prefixes_generator_emits_primary_and_management(fixture_fleet):
    sql = _load("46-prefixes.py").generate()
    assert "'primary'" in sql
    assert "'management'" in sql
    assert 'INSERT INTO "IpamPrefixVlanRole"' in sql
    assert "'192.168.200.0/24'::cidr" in sql
    assert "'192.168.105.0/24'::cidr" in sql
    assert 'SELECT id FROM "IpamPrefixVlanRole" WHERE slug =' in sql
    assert "00000000-0000-0000-0000-111111111111" in sql
    assert "ON CONFLICT (id) DO UPDATE" in sql


def test_prefixes_generator_idempotent_output(fixture_fleet):
    assert _load("46-prefixes.py").generate() == _load("46-prefixes.py").generate()


def test_prefixes_generator_emits_each_subnet_once_not_once_per_zone(fixture_fleet_multi):
    sql = _load("46-prefixes.py").generate()
    assert sql.count('INSERT INTO "Prefix"') == 2
    assert sql.count('INSERT INTO "Gateway"') == 1
    assert "00000000-0000-0000-0000-111111111111" in sql
    assert "00000000-0000-0000-0000-111111111112" not in sql


def test_prefixes_generator_never_repeats_a_cidr(fixture_fleet_multi):
    cidrs = _cidrs(_load("46-prefixes.py").generate())
    assert len(cidrs) == len(set(cidrs)), f"Prefix_active_unique would reject these: {cidrs}"


def test_prefixes_generator_never_repeats_a_cidr_single_zone(fixture_fleet):
    cidrs = _cidrs(_load("46-prefixes.py").generate())
    assert len(cidrs) == len(set(cidrs))


def test_prefixes_gateway_ips_do_not_collide_with_zone_bridge_ips(fixture_fleet_multi):
    zone_ips = set(_inets(_load("45-zone.py").generate()))
    prefix_ips = set(_inets(_load("46-prefixes.py").generate()))
    assert not (zone_ips & prefix_ips), f"IpAddress_active_unique would reject these: {zone_ips & prefix_ips}"


def test_vrfs_vlan_groups_generator_emits_vrf_and_zone_groups(fixture_fleet):
    sql = _load("47-vrfs-vlan-groups.py").generate()
    assert 'INSERT INTO "Vrf"' in sql
    assert "'sim-vrf'" in sql
    assert "'65000:1'" in sql
    assert 'INSERT INTO "VlanGroup"' in sql
    assert "'sim-zone-vlans'" in sql
    assert "00000000-0000-0000-0000-111111111111" in sql
    assert 'UPDATE "Prefix"' in sql
    assert 'SET "vrfId"' in sql
    assert "ON CONFLICT (id) DO UPDATE" in sql
    assert '"deletedAt" = NULL' in sql


def test_vrfs_vlan_groups_generator_idempotent_output(fixture_fleet):
    assert _load("47-vrfs-vlan-groups.py").generate() == _load("47-vrfs-vlan-groups.py").generate()


def test_vrfs_vlan_groups_generator_one_group_per_zone(fixture_fleet_multi):
    sql = _load("47-vrfs-vlan-groups.py").generate()
    assert sql.count('INSERT INTO "Vrf"') == 1
    assert sql.count('INSERT INTO "VlanGroup"') == 2


def test_vrfs_vlan_groups_sweep_names_the_prefixes_46_emits(fixture_fleet):
    seeded = _prefix_ids(_load("46-prefixes.py").generate())
    sql = _load("47-vrfs-vlan-groups.py").generate()
    assert seeded
    assert "p.id IN (" in sql
    for prefix_id in seeded:
        assert q(prefix_id) in sql


def test_vrfs_vlan_groups_sweep_names_the_prefixes_46_emits_multi_zone(fixture_fleet_multi):
    seeded = _prefix_ids(_load("46-prefixes.py").generate())
    sql = _load("47-vrfs-vlan-groups.py").generate()
    assert seeded
    for prefix_id in seeded:
        assert q(prefix_id) in sql


def test_vrfs_vlan_groups_sweep_drops_the_org_wide_predicate(fixture_fleet):
    sweep = _sweep(_load("47-vrfs-vlan-groups.py").generate())
    assert '("vrfId" IS NULL OR "vrfId" =' not in sweep


def test_vrfs_vlan_groups_sweep_guards_the_target_vrf_slot(fixture_fleet):
    sweep = _sweep(_load("47-vrfs-vlan-groups.py").generate())
    assert "NOT EXISTS" in sweep
    assert 'o."vrfId" = ' in sweep
    assert "o.prefix = p.prefix" in sweep
    assert "o.id <> p.id" in sweep


def test_vlans_ip_ranges_generator_emits_vlans_and_admin_pools(fixture_fleet):
    sql = _load("48-vlans-ip-ranges.py").generate()
    assert sql.count('INSERT INTO "Vlan"') == 3
    assert "'sim-zone-sim-data'" in sql
    assert "'sim-zone-sim-management'" in sql
    assert "'sim-zone-sim-reserved'" in sql
    assert "100," in sql and "200," in sql and "300," in sql
    assert "'RESERVED'::\"VlanStatus\"" in sql
    assert 'INSERT INTO "IpRange"' in sql
    assert "'sim-admin-pool'" in sql
    assert "'sim-bmc-admin-pool'" in sql
    assert "'192.168.200.100'::inet" in sql and "'192.168.200.109'::inet" in sql
    assert "'192.168.105.100'::inet" in sql and "'192.168.105.109'::inet" in sql
    assert 'UPDATE "Prefix"' in sql and 'SET "vlanId"' in sql
    assert "ON CONFLICT (id) DO UPDATE" in sql
    assert '"deletedAt" = NULL' in sql


def test_vlans_ip_ranges_generator_idempotent_output(fixture_fleet):
    assert _load("48-vlans-ip-ranges.py").generate() == _load("48-vlans-ip-ranges.py").generate()


def test_vlans_ip_ranges_generator_scales_with_zones(fixture_fleet_multi):
    sql = _load("48-vlans-ip-ranges.py").generate()
    assert sql.count('INSERT INTO "Vlan"') == 6
    assert sql.count("'sim-admin-pool'") == 1
    assert sql.count("'sim-bmc-admin-pool'") == 1


def test_vlans_generator_steps_the_vid_so_one_vrf_stays_unique(fixture_fleet_multi):
    vids = _vids(_load("48-vlans-ip-ranges.py").generate())
    assert sorted(vids) == [100, 101, 200, 201, 300, 301]


def test_vlans_generator_never_repeats_a_vid(fixture_fleet_multi):
    vids = _vids(_load("48-vlans-ip-ranges.py").generate())
    assert len(vids) == len(set(vids)), f"Vlan_active_unique_vid would reject these: {vids}"


def test_vlans_generator_never_repeats_a_vid_single_zone(fixture_fleet):
    vids = _vids(_load("48-vlans-ip-ranges.py").generate())
    assert len(vids) == len(set(vids))


def test_listing_generator_is_set_based():
    sql = _load("60-listing.py").generate()
    assert '"isListed" = TRUE' in sql
    assert "1.0000" in sql
    assert "'Server'::\"DeviceRole\"" in sql
    assert "ServerOperatingSystem" not in sql


def test_device_diagnostics_generator_emits_historical_bounded_diagnostics(fixture_fleet):
    sql = _load("61-device-diagnostics.py").generate()

    assert sql.lstrip().startswith("-- GENERATED")
    assert sql.rstrip().endswith("COMMIT;")
    assert sql.count('INSERT INTO "DeviceTestRun"') == 25
    assert sql.count('INSERT INTO "Deployment"') == 3
    assert sql.count('INSERT INTO "DeviceDiagnostics"') == 4
    assert sql.count("ON CONFLICT (id) DO UPDATE") == 32
    assert "Device 0 has 21 runs so the diagnostics endpoint returns its newest 20." in sql
    assert "2026-07-21T10:30:00.000Z" in sql
    assert '"NCCL_TIMEOUT"' in sql
    assert '"THERMAL_LIMIT"' in sql
    assert '"LINK_DOWN"' in sql
    assert '"timing"' in sql
    assert '"gpu_metrics"' in sql
    assert '"nccl_metrics"' in sql
    assert '"XID_79"' in sql
    for diagnostic_type in ("Driver", "Thermal", "Ecc", "Fabric"):
        assert f"'{diagnostic_type}'::\"DeviceDiagnosticsType\"" in sql
    assert "Historical ended deployments only" in sql
    assert '"endDate"' in sql
    assert '"lifecycleStatus"' not in sql
    assert "WHERE d.id = " in sql
    assert 'd."deletedAt" IS NULL' in sql
    assert 'JOIN "User" u ON u.email' in sql
    assert sim_device_uuid(0) in sql
    assert sim_device_uuid(1) in sql


def test_device_diagnostics_generator_output_is_stable(fixture_fleet):
    generator = _load("61-device-diagnostics.py")
    assert generator.generate() == generator.generate()


def test_device_documents_generator_emits_sample_documents(fixture_fleet):
    sql = _load("62-device-documents.py").generate()

    assert sql.lstrip().startswith("-- GENERATED")
    assert sql.rstrip().endswith("COMMIT;")
    assert sql.count('INSERT INTO "DeviceDocument"') == 4
    assert sql.count("ON CONFLICT (id) DO UPDATE") == 4
    assert "https://example.com/sim/rack-layout.pdf" in sql
    assert "https://example.com/sim/warranty.pdf" in sql
    assert "https://example.com/sim/bmc-creds.png" in sql
    assert "https://example.com/sim/packing-slip.pdf" in sql
    assert "Rack layout" in sql
    assert "Warranty certificate" in sql
    assert 'JOIN "User" u ON u.email' in sql
    assert "brokkr@brokkr.local" in sql
    assert sim_device_uuid(0) in sql
    assert sim_device_uuid(1) in sql
    assert "d.role = 'Server'::\"DeviceRole\"" in sql
    assert 'd."deletedAt" IS NULL' in sql


def test_device_documents_generator_output_is_stable(fixture_fleet):
    generator = _load("62-device-documents.py")
    assert generator.generate() == generator.generate()


def test_ssh_keys_generator_resolves_user_by_email_subquery():
    sql = _load("30-ssh-keys.py").generate()
    assert sql.lstrip().startswith("-- GENERATED")
    emitted_keys = 'INSERT INTO "SshKeys"' in sql and 'FROM "User"' in sql
    assert emitted_keys or "nothing to seed" in sql


def _os_manifest(pipeline_id):
    return {
        "version": "test-1",
        "groups": [{"slug": "os", "name": "OS", "selection_type": "SINGLE_SELECT"}],
        "layers": [
            {
                "name": "ubuntu-2404",
                "group": "os",
                "kind": "base",
                "display_name": "Ubuntu 24.04",
                "version": "24.04",
                "family": "ubuntu",
                "os_distro": "ubuntu",
                "os_codename": "noble",
                "os_version": "24.04",
                "arch": "amd64",
                "sha256": "a" * 64,
                "url": "https://example.test/img",
                "size": 123,
                "built_at": "2026-01-01T00:00:00Z",
                "built_by_pipeline_id": pipeline_id,
            }
        ],
    }


def _os_manifest_with_legacy(pipeline_id):
    base = _os_manifest(pipeline_id)
    base["groups"].append({"slug": "legacy", "name": "Legacy Bundles", "selection_type": "SINGLE_SELECT"})
    base["layers"].append(
        {
            "name": "centos-legacy-bundle",
            "group": "legacy",
            "kind": "legacy",
            "display_name": "CentOS Legacy",
            "version": "7",
            "family": "centos",
            "os_distro": "centos",
            "os_codename": "7",
            "os_version": "7",
            "arch": "amd64",
            "sha256": "b" * 64,
            "url": "https://example.test/legacy",
            "size": 456,
            "built_at": "2026-01-01T00:00:00Z",
            "built_by_pipeline_id": pipeline_id,
        }
    )
    return base


def _run_os_catalog(monkeypatch, manifest_fn):
    import local.seed.os_catalog as os_catalog

    def run(pipeline_id):
        manifest = manifest_fn(pipeline_id)
        monkeypatch.setattr(os_catalog, "fetch_manifest", lambda: manifest)
        return _load("40-os-catalog.py").generate()

    return run


@pytest.fixture
def os_catalog(monkeypatch):
    return _run_os_catalog(monkeypatch, _os_manifest)


@pytest.fixture
def os_catalog_with_legacy(monkeypatch):
    return _run_os_catalog(monkeypatch, _os_manifest_with_legacy)


def test_os_catalog_emits_system_layers(os_catalog):
    sql = os_catalog(1)
    assert "'liveOS'" in sql
    assert "'Live & System Images'" in sql
    for slug, kind in [
        ("ubuntu-rescue-os", "LIVE"),
        ("brokkr-discovery", "LIVE"),
        ("ipxe-custom", "BASE"),
    ]:
        block = re.search(
            rf"INSERT INTO \"Layer\"[^;]*'{re.escape(slug)}'[^;]*ON CONFLICT",
            sql,
            re.S,
        )
        assert block, f"no Layer INSERT found for slug '{slug}'"
        assert f"'{kind}'::\"LayerKind\"" in block.group(), (
            f"layer '{slug}' expected kind={kind} within its INSERT block"
        )
    assert "'baseOS'" in sql
    assert "'Base OS Images'" in sql
    assert "kind = EXCLUDED.kind" in sql
    assert "family = EXCLUDED.family" in sql


def test_os_catalog_pipeline_id_none_emits_null(os_catalog):
    sql = os_catalog(None)
    assert "::timestamp, NULL," in sql


def test_os_catalog_pipeline_id_rejects_sql_payload(os_catalog):
    payload = '1); DROP TABLE "Device"; --'
    with pytest.raises(ValueError):
        os_catalog(payload)


def test_os_catalog_drops_legacy_entries(os_catalog_with_legacy):
    sql = os_catalog_with_legacy(1)
    assert "'legacy'" not in sql, "legacy group slug found in generated SQL"
    assert "centos-legacy-bundle" not in sql
    assert "'os'" in sql
    assert "'ubuntu-2404'" in sql


def test_os_catalog_seeds_layer_build_and_platform_settings(os_catalog):
    sql = os_catalog(1)
    assert 'INSERT INTO "LayerBuild"' in sql
    assert "'local-sim-seed'" in sql
    assert 'INSERT INTO "PlatformSettings"' in sql


def test_os_catalog_artifacts_carry_layer_build_id(os_catalog):
    sql = os_catalog(1)
    artifact_blocks = re.findall(r'INSERT INTO "LayerArtifact"[^;]+;', sql, re.S)
    assert artifact_blocks, "expected at least one LayerArtifact INSERT"
    for block in artifact_blocks:
        assert "'local-sim-seed'" in block, "LayerArtifact INSERT missing layerBuildId='local-sim-seed'"


def test_os_catalog_artifact_upsert_keys_on_slot(os_catalog):
    sql = os_catalog(1)
    assert 'ON CONFLICT ("layerBuildId", "layerId", "osDistro", "osCodename", arch, variant)' in sql


def test_os_catalog_degrades_to_system_layers_when_manifest_unreachable(monkeypatch):
    import local.seed.os_catalog as os_catalog_mod

    def boom():
        raise RuntimeError("failed to fetch http://127.0.0.1:9/nope")

    monkeypatch.setattr(os_catalog_mod, "fetch_manifest", boom)
    sql = _load("40-os-catalog.py").generate()
    assert sql.count("BEGIN;") == 1
    assert sql.rstrip().endswith("COMMIT;")
    assert 'INSERT INTO "LayerBuild"' in sql
    for slug in ("ubuntu-rescue-os", "brokkr-discovery", "ipxe-custom"):
        assert f"'{slug}'" in sql
    assert 'INSERT INTO "LayerArtifact"' not in sql
    assert "'ubuntu-2404'" not in sql


_BAREMETAL_FLEET = (
    "network: {name: t, cidr: 198.51.100.0/24, domain: t.local, bmc_cidr: 198.51.100.0/24}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "nodes: []\n"
    "baremetal:\n"
    "  iface: enp35s0\n"
    "  iface_ip: 198.51.100.10\n"
    "  arch: amd64\n"
    "  nodes:\n"
    '    - {name: bench-1, pxe_mac: "00:00:5e:00:53:b4", bmc_mac: "00:00:5e:00:53:b5", bmc_ip: 198.51.100.250}\n'
    "    - name: bench-2\n"
    '      pxe_mac: "00:00:5e:00:53:c4"\n'
    '      bmc_mac: "00:00:5e:00:53:c5"\n'
    "      bmc_ip: 198.51.100.251\n"
    "      arch: arm64\n"
)


def _pin_fleet(tmp_path, monkeypatch, text: str):
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(text)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
    cfg.get_settings.cache_clear()
    return fleet_path


def test_prune_generator_bounds_the_range_at_the_live_node_count(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("49-device-prune.py").generate()

    assert "right(id, 12)::bigint > 4" in sql


def test_prune_generator_never_reaches_a_bridge_device(tmp_path, monkeypatch):
    from local.zones import BRIDGE_ORDINAL_BASE

    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("49-device-prune.py").generate()

    assert f"right(id, 12)::bigint < {BRIDGE_ORDINAL_BASE}" in sql
    assert BRIDGE_ORDINAL_BASE > 4


def test_prune_generator_soft_deletes_rather_than_removing(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("49-device-prune.py").generate()

    assert 'DELETE FROM "Device"' not in sql
    assert '"deletedAt" = NOW()' in sql
    assert '"deletedAt" IS NULL' in sql


def test_prune_generator_scopes_to_the_sim_org(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("49-device-prune.py").generate()

    assert '"supplierId" = ' in sql


def test_devices_generator_frees_the_name_a_shifted_id_needs(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("50-devices.py").generate()

    assert "'00000000-0000-0000-0000-000000000004', 'zone1-cpu-5'" in sql
    assert (
        "AND \"zoneId\" = '00000000-0000-0000-0000-111111111112' AND name = 'zone1-cpu-5'\n"
        "  AND id <> '00000000-0000-0000-0000-000000000004'"
    ) in sql


def test_devices_generator_clears_one_name_per_seeded_node(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("50-devices.py").generate()

    assert sql.count('UPDATE "Device" SET "deletedAt" = NOW()') == sql.count('INSERT INTO "Device"')


def test_device_name_clear_excludes_its_own_id_so_a_reseed_is_a_noop(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    for gen in ("50-devices.py", "51-commissioning-devices.py"):
        sql = _load(gen).generate()
        clears = sql.count('UPDATE "Device" SET "deletedAt" = NOW()')
        assert sql.count("AND id <> '") == clears, gen


def test_baremetal_generator_frees_the_name_a_corrected_pxe_mac_needs(tmp_path, monkeypatch):
    from local.derived import bm_device_uuid
    from local.zones import zone_uuid

    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()

    assert 'UPDATE "Device" SET "deletedAt" = NOW(), "updatedAt" = NOW()' in sql
    assert (
        f'AND "zoneId" = {q(zone_uuid(0))} AND name = {q("bench-1")}\n'
        f"  AND id <> {q(bm_device_uuid('00:00:5e:00:53:b4'))}"
    ) in sql


def test_baremetal_generator_clears_one_name_per_seeded_machine(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()

    assert sql.count('UPDATE "Device" SET "deletedAt" = NOW()') == sql.count('INSERT INTO "Device"')


def test_devices_generator_frees_a_seal_bound_to_another_zone(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("50-devices.py").generate()

    assert (
        'DELETE FROM "DeviceSecret"\n'
        "WHERE \"deviceId\" = '00000000-0000-0000-0000-000000000004' "
        "AND \"zoneId\" <> '00000000-0000-0000-0000-111111111112';"
    ) in sql


def test_devices_generator_frees_one_seal_per_seeded_node(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("50-devices.py").generate()

    assert sql.count('DELETE FROM "DeviceSecret"') == sql.count('INSERT INTO "Device"')


def test_zone_move_prep_spares_the_target_zone_so_a_reseed_is_a_noop(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET_MIXED)
    for gen in ("50-devices.py", "51-commissioning-devices.py"):
        sql = _load(gen).generate()
        deletes = sql.count('DELETE FROM "DeviceSecret"')
        assert deletes > 0, gen
        assert sql.count('AND "zoneId" <> \'') == deletes, gen


def test_devices_generator_revives_a_tombstoned_row_it_owns(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("50-devices.py").generate()

    assert sql.count('"deletedAt" = NULL, "updatedAt" = NOW();') == sql.count('INSERT INTO "Device"')


def test_commissioning_generator_revives_a_tombstoned_row_it_owns(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET_MIXED)
    sql = _load("51-commissioning-devices.py").generate()

    assert sql.count('"deletedAt" = NULL, "updatedAt" = NOW();') == sql.count('INSERT INTO "Device"')


def test_devices_generator_brackets_the_role_write_once_trigger(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("50-devices.py").generate()

    off = sql.index('ALTER TABLE "Device" DISABLE TRIGGER device_role_write_once;')
    on = sql.index('ALTER TABLE "Device" ENABLE TRIGGER device_role_write_once;')
    assert sql.index("BEGIN;") < off < sql.index('INSERT INTO "Device"')
    assert sql.rindex('INSERT INTO "Device"') < on < sql.index("COMMIT;")


def test_commissioning_generator_brackets_the_role_write_once_trigger(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET_MIXED)
    sql = _load("51-commissioning-devices.py").generate()

    off = sql.index('ALTER TABLE "Device" DISABLE TRIGGER device_role_write_once;')
    on = sql.index('ALTER TABLE "Device" ENABLE TRIGGER device_role_write_once;')
    assert sql.index("BEGIN;") < off < sql.index('INSERT INTO "Device"')
    assert sql.rindex('INSERT INTO "Device"') < on < sql.index("COMMIT;")


def test_commissioning_generator_omits_the_bracket_with_no_commissioning_node(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _SHRUNK_FLEET)
    sql = _load("51-commissioning-devices.py").generate()

    assert 'INSERT INTO "Device"' not in sql
    assert "device_role_write_once" not in sql


def test_baremetal_generator_noop_without_a_machine(fixture_fleet):
    sql = _load("52-baremetal-devices.py").generate()
    assert sql.lstrip().startswith("-- GENERATED")
    assert 'INSERT INTO "Device"' not in sql
    assert "no bare-metal devices to seed" in sql


def test_seeds_bare_metal_devices_whenever_the_roster_carries_a_machine(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _TWO_PLANE_FLEET)
    sql = _load("52-baremetal-devices.py").generate()
    assert sql.count('INSERT INTO "Device"') == 1
    assert "'bench-1'" in sql
    assert "cpu-1" not in sql


def test_baremetal_generator_seeds_server_active_shape(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()

    assert sql.count('INSERT INTO "Device"') == 2
    assert sql.count("'Server'::\"DeviceRole\"") == 2
    assert sql.count("'ACTIVE'::\"DeviceStatus\"") == 2
    assert sql.count("'Baremetal'::\"DeviceType\"") == 2
    assert sql.count('INSERT INTO "Server"') == 2
    assert "ON CONFLICT (id) DO UPDATE" in sql
    assert 'ON CONFLICT ("deviceId") DO NOTHING' in sql
    assert "role = EXCLUDED.role" not in sql
    assert "status = EXCLUDED.status" not in sql
    assert sql.lstrip().startswith("-- GENERATED")
    assert sql.rstrip().endswith("COMMIT;")


def test_baremetal_generator_keys_device_on_pxe_mac(tmp_path, monkeypatch):
    from local.derived import bm_device_uuid, sim_device_uuid

    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()
    assert bm_device_uuid("00:00:5e:00:53:b4") in sql
    assert bm_device_uuid("00:00:5e:00:53:c4") in sql
    assert sim_device_uuid(0) not in sql


def test_baremetal_generator_interfaces_and_ipmi_ip(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()

    assert sql.count("'eth0'") >= 2
    assert "'00:00:5e:00:53:b4'" in sql
    assert "'00:00:5e:00:53:b5'" in sql
    assert "'198.51.100.250'::inet" in sql
    assert "name = 'eth0'" not in sql


def test_keeps_a_renamed_data_interface_and_inserts_eth0_only_when_no_row_carries_the_pxe_mac(tmp_path, monkeypatch):
    from local.derived import bm_device_uuid

    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()
    mac = "00:00:5e:00:53:b4"
    pxe_row = f'"deviceId" = {q(bm_device_uuid(mac))} AND lower("macAddress") = {q(mac)} AND "deletedAt" IS NULL'

    updates = re.findall(r'UPDATE "Interface" SET[^;]*;', sql)
    assert len(updates) == 2
    assert f"WHERE {pxe_row};" in updates[0]
    assert "type = 'ETHERNET_1G'::\"InterfaceType\"" in updates[0]
    assert "enabled = true" in updates[0]
    assert '"mgmtOnly" = false' in updates[0]
    assert "description = 'Primary data NIC (PXE)'" in updates[0]
    assert '"updatedAt" = NOW()' in updates[0]
    assert "name =" not in updates[0]
    assert '"macAddress" =' not in updates[0]

    eth0_inserts = re.findall(r'INSERT INTO "Interface"[^;]*\'eth0\'[^;]*;', sql)
    assert len(eth0_inserts) == 2
    assert f'WHERE NOT EXISTS (SELECT 1 FROM "Interface" WHERE {pxe_row});' in eth0_inserts[0]
    assert "ON CONFLICT" not in eth0_inserts[0]
    assert sql.index(updates[0]) < sql.index(eth0_inserts[0])
    assert sql.count('ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET') == 2


def test_baremetal_generator_omits_storage_and_netplan(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()
    assert 'INSERT INTO "StorageDrive"' not in sql
    assert '"storageLayouts"' not in sql
    assert '"netplanOverride"' not in sql


def test_baremetal_generator_per_node_arch_override(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()
    assert "arch=amd64" in sql and "arch=arm64" in sql
    assert "'ttyS0'" in sql and "'ttyAMA0'" in sql


def test_baremetal_generator_rejects_bad_network_type(tmp_path, monkeypatch):
    fleet = _BAREMETAL_FLEET.replace(
        "bmc_ip: 198.51.100.250}",
        "bmc_ip: 198.51.100.250, network_type: bogus}",
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)
    with pytest.raises(ValidationError, match="network_type"):
        _load("52-baremetal-devices.py").generate()


def test_baremetal_generator_rejects_private_network_type(tmp_path, monkeypatch):
    fleet = _BAREMETAL_FLEET.replace(
        "bmc_ip: 198.51.100.250}",
        "bmc_ip: 198.51.100.250, network_type: private}",
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)
    with pytest.raises(ValidationError, match="network_type"):
        _load("52-baremetal-devices.py").generate()
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load("52-baremetal-devices.py").generate()
    assert "'Private'::\"DeviceNetworkType\"" not in sql


def test_baremetal_generator_lowercases_macs_from_the_model(tmp_path, monkeypatch):
    from local.derived import bm_device_uuid

    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET.replace("00:00:5e:00:53:b4", "00:00:5E:00:53:B4"))
    sql = _load("52-baremetal-devices.py").generate()
    assert "'00:00:5e:00:53:b4'" in sql
    assert "00:00:5E:00:53:B4" not in sql
    assert bm_device_uuid("00:00:5e:00:53:b4") in sql


def test_baremetal_generator_network_type_mapping(tmp_path, monkeypatch):
    fleet = _BAREMETAL_FLEET.replace(
        "bmc_ip: 198.51.100.250}",
        "bmc_ip: 198.51.100.250, network_type: nat}",
    ).replace(
        "      bmc_ip: 198.51.100.251\n      arch: arm64\n",
        "      bmc_ip: 198.51.100.251\n      arch: arm64\n      network_type: public\n",
    )
    _pin_fleet(tmp_path, monkeypatch, fleet)
    sql = _load("52-baremetal-devices.py").generate()
    assert "net=NAT" in sql
    assert "net=Public" in sql
    assert "'NAT'::\"DeviceNetworkType\"" in sql
    assert "'Public'::\"DeviceNetworkType\"" in sql


def test_baremetal_generator_noop_when_the_block_has_no_machines(tmp_path, monkeypatch):
    empty = (
        "network: {name: t, cidr: 198.51.100.0/24, domain: t.local, bmc_cidr: 198.51.100.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes: []\n"
        "baremetal:\n"
        "  iface: enp35s0\n"
        "  iface_ip: 198.51.100.10\n"
        "  arch: amd64\n"
        "  nodes: []\n"
    )
    _pin_fleet(tmp_path, monkeypatch, empty)
    sql = _load("52-baremetal-devices.py").generate()
    assert "no bare-metal devices to seed" in sql
    assert "BEGIN;" not in sql


def test_baremetal_generator_rejects_duplicate_pxe_mac(tmp_path, monkeypatch):
    dup = (
        "network: {name: t, cidr: 198.51.100.0/24, domain: t.local, bmc_cidr: 198.51.100.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes: []\n"
        "baremetal:\n"
        "  iface: enp35s0\n"
        "  iface_ip: 198.51.100.10\n"
        "  arch: amd64\n"
        "  nodes:\n"
        '    - {name: bench-1, pxe_mac: "00:00:5e:00:53:b4", bmc_mac: "00:00:5e:00:53:b5", bmc_ip: 198.51.100.250}\n'
        '    - {name: bench-2, pxe_mac: "00:00:5e:00:53:b4", bmc_mac: "00:00:5e:00:53:c5", bmc_ip: 198.51.100.251}\n'
    )
    _pin_fleet(tmp_path, monkeypatch, dup)
    with pytest.raises(ValidationError, match="duplicate mac"):
        _load("52-baremetal-devices.py").generate()


def test_baremetal_generator_output_is_stable(tmp_path, monkeypatch):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    first = _load("52-baremetal-devices.py").generate()
    cfg.get_settings.cache_clear()
    second = _load("52-baremetal-devices.py").generate()
    assert first == second


@pytest.mark.parametrize("gen", ["50-devices.py", "55-dcim.py"])
def test_vm_generators_noop_without_a_vm_node(tmp_path, monkeypatch, gen):
    _pin_fleet(tmp_path, monkeypatch, _BAREMETAL_FLEET)
    sql = _load(gen).generate()
    assert sql.lstrip().startswith("-- GENERATED")
    assert 'INSERT INTO "Device"' not in sql
    assert "no VM nodes" in sql


@pytest.fixture
def fleet_dhcp_factory(tmp_path, monkeypatch):
    def _make(fleet_yaml: str) -> Path:
        fleet_path = tmp_path / "fleet.yml"
        fleet_path.write_text(fleet_yaml)
        monkeypatch.setenv("LOCAL_FLEET_PATH", str(fleet_path))
        cfg.get_settings.cache_clear()
        return fleet_path

    return _make


_DHCP_FLEET = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24, dhcp: true}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
)


_RENDERED_NETPLAN_FLEET = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24,"
    " rendered_netplan: true}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
)


@pytest.fixture
def fixture_fleet_dhcp(fleet_dhcp_factory):
    return fleet_dhcp_factory(_DHCP_FLEET)


def test_devices_generator_dhcp_mode_uses_dhcp4_netplan(fixture_fleet_dhcp):
    sql = _load("50-devices.py").generate()
    assert "dhcp4: true" in sql
    assert "addresses: [192.168.200.10/24]" not in sql
    assert "'192.168.200.10/24'::inet" in sql
    assert "52:54:00:da:00:01" in sql


def test_prefixes_generator_dhcp_off_leaves_primary_plain_and_seeds_gateway_fixture(fixture_fleet):
    sql = _load("46-prefixes.py").generate()
    fixture_ip_id = "fb2f4b4b-131a-52c5-bf31-7c04fd138436"
    gateway_id = "ac094463-5e6a-5975-b582-ea3ad3413a6a"
    prefix_id = "50c42ad4-7cb0-5926-9a47-b1ed7fd8afec"
    assert "AUTHORITATIVE" not in sql
    assert 'INSERT INTO "IpRange"' not in sql
    assert sql.count('INSERT INTO "Gateway"') == 1
    assert f"VALUES ('{gateway_id}', 100, NULL, '{fixture_ip_id}', '{prefix_id}', NOW(), NOW())" in sql
    assert f"'{fixture_ip_id}'," in sql and "'192.168.105.1/24'::inet" in sql
    assert "192.168.200.1/24" not in sql
    assert '"dhcpMode" = EXCLUDED."dhcpMode"' in sql


def test_prefixes_generator_dhcp_on_configures_primary_and_seeds_management_gateway(fixture_fleet_dhcp):
    sql = _load("46-prefixes.py").generate()
    assert sql.count("'AUTHORITATIVE'::\"DhcpMode\"") == 1
    assert sql.count("'192.168.200.1/24'::inet") == 1
    assert sql.count("'192.168.105.1/24'::inet") == 1
    assert sql.count('INSERT INTO "Gateway"') == 1
    assert 'INSERT INTO "IpRange"' in sql
    assert "'192.168.200.200'::inet" in sql and "'192.168.200.250'::inet" in sql
    assert '"macAddress"' not in sql


@pytest.mark.parametrize(
    "cidr,expected_start,expected_end",
    [
        ("192.168.200.0/25", "192.168.200.125", "192.168.200.126"),
        ("10.0.0.0/26", "10.0.0.61", "10.0.0.62"),
    ],
)
def test_prefixes_generator_dhcp_pool_stays_within_narrow_cidr(fleet_dhcp_factory, cidr, expected_start, expected_end):
    import ipaddress

    fleet = (
        f"network: {{name: t, cidr: {cidr}, domain: t.local, bmc_cidr: 192.168.105.0/24, dhcp: true}}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
    )
    fleet_dhcp_factory(fleet)

    sql = _load("46-prefixes.py").generate()
    net = ipaddress.ip_network(cidr, strict=False)
    assert f"'{expected_start}'::inet" in sql
    assert f"'{expected_end}'::inet" in sql
    assert ipaddress.ip_address(expected_start) in net
    assert ipaddress.ip_address(expected_end) in net


def test_prefixes_generator_dhcp_pool_above_device_reservations(fleet_dhcp_factory):
    import ipaddress

    nodes = "\n".join(
        f'  - {{name: cpu-{i}, ipmi_mac: "52:54:00:bc:00:{i:02x}", data_mac: "52:54:00:da:00:{i:02x}"}}'
        for i in range(1, 21)
    )
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24, dhcp: true}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        f"nodes:\n{nodes}\n"
    )
    fleet_dhcp_factory(fleet)

    sql = _load("46-prefixes.py").generate()
    assert "'192.168.200.200'::inet" in sql
    assert "'192.168.200.250'::inet" in sql

    import re

    pool_match = re.findall(r"'(192\.168\.200\.\d+)'::inet", sql)
    pool_ips = [ipaddress.ip_address(ip) for ip in pool_match if int(ip.split(".")[-1]) >= 30]
    last_device_ip = ipaddress.ip_address("192.168.200.29")
    for ip in pool_ips:
        assert ip > last_device_ip, f"pool IP {ip} overlaps device reservation range"


def test_prefixes_generator_dhcp_pool_above_reservations_narrow_cidr(fleet_dhcp_factory):
    import ipaddress

    nodes = "\n".join(
        f'  - {{name: cpu-{i}, ipmi_mac: "52:54:00:bc:00:{i:02x}", data_mac: "52:54:00:da:00:{i:02x}"}}'
        for i in range(1, 21)
    )
    fleet = (
        "network: {name: t, cidr: 192.168.200.0/25, domain: t.local, bmc_cidr: 192.168.105.0/24, dhcp: true}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        f"nodes:\n{nodes}\n"
    )
    fleet_dhcp_factory(fleet)

    sql = _load("46-prefixes.py").generate()
    net = ipaddress.ip_network("192.168.200.0/25", strict=False)

    import re

    pool_ips = re.findall(r"'(192\.168\.200\.\d+)'::inet", sql)
    pool_addrs = sorted(
        [ipaddress.ip_address(ip) for ip in pool_ips if int(ip.split(".")[-1]) >= 30],
    )
    last_device_ip = ipaddress.ip_address("192.168.200.29")
    assert len(pool_addrs) >= 2, "expected at least pool_start and pool_end"
    assert pool_addrs[0] > last_device_ip, f"pool start {pool_addrs[0]} overlaps device range"
    assert pool_addrs[-1] < net.broadcast_address, f"pool end {pool_addrs[-1]} at or past broadcast"


@pytest.mark.parametrize("cidr", ["192.168.200.0/30", "10.0.0.0/28"])
def test_prefixes_generator_dhcp_pool_rejects_tiny_cidr(fleet_dhcp_factory, cidr):
    fleet = (
        f"network: {{name: t, cidr: {cidr}, domain: t.local, bmc_cidr: 192.168.105.0/24, dhcp: true}}\n"
        "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
        "nodes:\n"
        '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
    )
    fleet_dhcp_factory(fleet)

    with pytest.raises(ValueError, match="DHCP pool cannot fit"):
        _load("46-prefixes.py").generate()


@pytest.mark.parametrize(
    "cidr,node_count",
    [("192.168.200.0/24", 4), ("192.168.200.0/24", 20), ("10.0.0.0/25", 4)],
)
def test_dhcp_pool_offsets_invariants(cidr, node_count):
    import ipaddress

    mod = _load("46-prefixes.py")
    net = ipaddress.ip_network(cidr, strict=False)
    start, end = mod._dhcp_pool_offsets(net, node_count)
    last_reservation = mod.NODE_IP_BASE + max(node_count - 1, 0)
    assert start > last_reservation + 5
    assert end <= net.num_addresses - 2
    assert end > start


_SHARED_NIC_FLEET = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01"}\n'
    '  - {name: commission-1, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02",\n'
    "     seed_as_server: false}\n"
)


def test_interface_emitter_renders_the_data_nic_spec_verbatim():
    from local.seed.interfaces import DATA_NIC, emit_interface

    assert emit_interface("dev-1", DATA_NIC, "52:54:00:da:00:01") == (
        'INSERT INTO "Interface"\n'
        '    (id, name, type, enabled, "macAddress", "mgmtOnly", "deviceId", description, "updatedAt")\n'
        "VALUES (gen_random_uuid(), 'eth0', 'ETHERNET_1G'::\"InterfaceType\", true,\n"
        "    '52:54:00:da:00:01', false, 'dev-1', 'Primary data NIC', NOW())\n"
        'ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET\n'
        '    type = EXCLUDED.type, "macAddress" = EXCLUDED."macAddress",\n'
        '    "mgmtOnly" = EXCLUDED."mgmtOnly", "updatedAt" = NOW();'
    )


def test_interface_emitter_renders_the_ipmi_nic_as_mgmt_only():
    from local.seed.interfaces import IPMI_NIC, emit_interface

    sql = emit_interface("dev-1", IPMI_NIC, "52:54:00:bc:00:01")
    assert "'IPMI', 'IPMI_BMC'::\"InterfaceType\", true," in sql
    assert "'52:54:00:bc:00:01', true, 'dev-1', 'BMC management interface', NOW())" in sql
    assert " True," not in sql and " False," not in sql


def test_ip_delete_emitter_scopes_to_the_live_interface_by_name():
    from local.seed.interfaces import IPMI_NIC, emit_ip_delete

    assert emit_ip_delete("dev-1", IPMI_NIC) == (
        'DELETE FROM "IpAddress" WHERE "interfaceId" IN\n'
        "    (SELECT id FROM \"Interface\" WHERE \"deviceId\" = 'dev-1' AND name = 'IPMI'"
        ' AND "deletedAt" IS NULL);'
    )


def test_ip_emitter_clears_the_nic_and_the_address_before_it_inserts():
    from local.seed.interfaces import (
        DATA_NIC,
        emit_ip_address_clear,
        emit_ip_delete,
        emit_ip_on_interface,
    )

    org = '(SELECT "organizationId" FROM "Zone" WHERE id = \'z\')'
    statements = emit_ip_on_interface("dev-1", DATA_NIC, "192.168.200.10/24", org)
    assert len(statements) == 3
    assert statements[0] == emit_ip_delete("dev-1", DATA_NIC)
    assert statements[1] == emit_ip_address_clear("192.168.200.10/24", org)
    assert statements[2] == (
        'INSERT INTO "IpAddress"\n'
        '    (id, address, status, "organizationId", "interfaceId", "assignedObjectType",'
        ' "assignedObjectId", "updatedAt")\n'
        "SELECT gen_random_uuid(), '192.168.200.10/24'::inet, 'ACTIVE'::\"IpStatus\","
        f" {org},\n"
        "    id, 'Interface'::\"AssignedObjectType\", id, NOW()\n"
        'FROM "Interface" WHERE "deviceId" = \'dev-1\' AND name = \'eth0\' AND "deletedAt" IS NULL;'
    )


def test_device_generators_emit_the_shared_ip_sql(tmp_path, monkeypatch):
    from local.seed.interfaces import DATA_NIC, IPMI_NIC, emit_interface, emit_ip_delete, emit_ip_on_interface
    from local.zones import zone_uuid

    monkeypatch.setenv("SIM_HOST_ARCH", "amd64")
    _pin_fleet(tmp_path, monkeypatch, _SHARED_NIC_FLEET)
    org = f'(SELECT "organizationId" FROM "Zone" WHERE id = \'{zone_uuid(0)}\')'

    devices = _load("50-devices.py").generate()
    server = sim_device_uuid(0)
    for statement in emit_ip_on_interface(server, IPMI_NIC, "192.168.105.10", org):
        assert statement in devices
    for statement in emit_ip_on_interface(server, DATA_NIC, "192.168.200.10/24", org):
        assert statement in devices

    commissioning = _load("51-commissioning-devices.py").generate()
    commission = sim_device_uuid(1)
    assert emit_interface(commission, DATA_NIC, "52:54:00:da:00:02") in commissioning
    assert emit_interface(commission, IPMI_NIC, "52:54:00:bc:00:02") in commissioning
    assert emit_ip_delete(commission, DATA_NIC) in commissioning
    for statement in emit_ip_on_interface(commission, IPMI_NIC, "192.168.105.11", org):
        assert statement in commissioning


def test_devices_generator_keeps_its_wide_interface_columns_inline(tmp_path, monkeypatch):
    from local.seed.interfaces import DATA_NIC, IPMI_NIC, emit_interface

    monkeypatch.setenv("SIM_HOST_ARCH", "amd64")
    _pin_fleet(tmp_path, monkeypatch, _SHARED_NIC_FLEET)

    devices = _load("50-devices.py").generate()
    server = sim_device_uuid(0)
    assert emit_interface(server, DATA_NIC, "52:54:00:da:00:01") not in devices
    assert emit_interface(server, IPMI_NIC, "52:54:00:bc:00:01") not in devices
    assert "'ETHERNET'::\"InterfaceLinkType\"" in devices
    assert "'INFINIBAND_HDR'::\"InterfaceType\"" in devices
    assert '"markConnected"' in devices


def test_ident_quotes_mixed_case_and_leaves_lowercase_bare():
    assert ident("id") == "id"
    assert ident("slug") == "slug"
    assert ident("deviceId") == '"deviceId"'
    assert ident("updatedAt") == '"updatedAt"'


def test_emit_upsert_renders_insert_values_and_a_derived_refresh_list():
    sql = emit_upsert("Tag", "id name slug", [q("i"), q("n"), q("s")], "name")
    assert sql == (
        'INSERT INTO "Tag" (id, name, slug, "updatedAt")\n'
        "VALUES ('i', 'n', 's', NOW())\n"
        "ON CONFLICT (name) DO UPDATE SET\n"
        '    slug = EXCLUDED.slug, "updatedAt" = NOW();'
    )


def test_emit_upsert_default_refresh_skips_id_and_the_conflict_target():
    sql = emit_upsert("Pdu", "id outletCount deviceId", [q("i"), 24, q("d")], "deviceId", updated_at=False)
    assert 'INSERT INTO "Pdu" (id, "outletCount", "deviceId")' in sql
    assert sql.endswith('ON CONFLICT ("deviceId") DO UPDATE SET\n    "outletCount" = EXCLUDED."outletCount";')


def test_emit_upsert_explicit_update_overrides_the_derived_list():
    sql = emit_upsert(
        "FrontPort", "id type rearPortId rearPortPosition", [q("i"), q("t"), q("r"), 1], "id", update="type rearPortId"
    )
    assert '"rearPortPosition" = EXCLUDED' not in sql
    assert '    type = EXCLUDED.type, "rearPortId" = EXCLUDED."rearPortId", "updatedAt" = NOW();' in sql


def test_emit_upsert_partial_index_conflict_target_carries_the_predicate():
    sql = emit_upsert(
        "Interface",
        "id name type deviceId",
        [q("i"), q("eth0"), q("t"), q("d")],
        "deviceId name",
        where='"deletedAt" IS NULL',
    )
    assert 'ON CONFLICT ("deviceId", name) WHERE "deletedAt" IS NULL DO UPDATE SET' in sql


def test_emit_upsert_do_nothing_skips_the_refresh_clause():
    sql = emit_upsert(
        "TagAssignment", "tagId objectId", [q("t"), q("o")], "tagId objectId", do_nothing=True, updated_at=False
    )
    assert sql.endswith('ON CONFLICT ("tagId", "objectId") DO NOTHING;')
    assert "EXCLUDED" not in sql


def test_emit_upsert_without_updated_at_emits_no_now_call():
    sql = emit_upsert("CableTermination", "id cableId portId", [q("i"), q("c"), q("p")], "cableId", updated_at=False)
    assert "NOW()" not in sql
    assert '"updatedAt"' not in sql


def test_emit_upsert_rejects_a_value_count_that_misaligns_with_the_columns():
    with pytest.raises(ValueError, match="3 columns but 2 values"):
        emit_upsert("Rack", "id name heightU", [q("i"), q("n")], "name")


def test_emit_upsert_rejects_a_conflict_target_that_leaves_nothing_to_refresh():
    with pytest.raises(ValueError, match="nothing to refresh"):
        emit_upsert("Manufacturer", "id name", [q("i"), q("n")], "name", updated_at=False)


def test_emit_upsert_rejects_refresh_columns_absent_from_the_insert_list():
    with pytest.raises(ValueError, match="absent from the insert list: slug color"):
        emit_upsert("Tag", "id name", [q("i"), q("n")], "name", update="slug color", updated_at=False)


def test_emit_upsert_rejects_an_update_list_it_would_silently_discard():
    with pytest.raises(ValueError, match="do_nothing would discard"):
        emit_upsert("TagAssignment", "id tagId", [q("i"), q("t")], "tagId", update="tagId", do_nothing=True)


def test_emit_upsert_rejects_updated_at_in_an_explicit_refresh_list():
    with pytest.raises(ValueError, match="appended automatically"):
        emit_upsert("Rack", "id name", [q("i"), q("n")], "name", update="name updatedAt")


def test_emit_upsert_wraps_every_clause_within_the_line_budget():
    cols = "id " + " ".join(f"columnNumber{i:02d}" for i in range(12))
    sql = emit_upsert("Wide", cols, [q("i"), *(q("x" * 20) for _ in range(12))], "id")
    assert len(sql.splitlines()) > 4
    for line in sql.splitlines():
        assert len(line) <= 120
        assert line.startswith(("INSERT", "VALUES", "ON CONFLICT", "    "))


def test_emit_upsert_continuation_lines_are_indented_not_reopened():
    cols = "id " + " ".join(f"columnNumber{i:02d}" for i in range(12))
    sql = emit_upsert("Wide", cols, [q("i"), *range(12)], "id")
    assert sql.count("INSERT INTO") == 1
    assert sql.count("VALUES (") == 1
    assert sql.rstrip().endswith(";")


_GOLDEN_DIR = Path(__file__).resolve().parent / "fixtures" / "sql-seed"

_OVERRIDES_FLEET = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01",\n'
    "     ip: 192.168.200.77, bmc_ip: 192.168.105.88, console_port: 9500, network_type: nat}\n"
    '  - {name: cpu-2, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02", network_type: public}\n'
    '  - {name: commission-1, ipmi_mac: "52:54:00:bc:00:03", data_mac: "52:54:00:da:00:03",\n'
    "     seed_as_server: false, ip: 192.168.200.99}\n"
    '  - {name: cpu-4, ipmi_mac: "52:54:00:bc:00:04", data_mac: "52:54:00:da:00:04"}\n'
)


# The two DB unique indexes a per-zone IPAM row silently violates: Prefix_active_unique is
# (org, vrfId, prefix) and Vlan_active_unique_vid is (org, vrfId, vid), both org-and-VRF-wide.
def _cidrs(sql: str) -> list[str]:
    return re.findall(r"'([0-9./]+)'::cidr", sql)


def _inets(sql: str) -> list[str]:
    return re.findall(r"'([0-9.]+/[0-9]+)'::inet", sql)


def _prefix_ids(sql: str) -> list[str]:
    return re.findall(r"'([0-9a-f-]{36})', '[0-9./]+'::cidr", sql)


def _sweep(sql: str) -> str:
    return sql.split("-- attach the seeded prefixes")[1].split(";")[0]


def _vids(sql: str) -> list[int]:
    return [int(v) for v in re.findall(r"^-- VLAN .* vid=(\d+) ", sql, re.M)]


_SHRUNK_FLEET = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "zones:\n"
    "  - {index: 0, name: sim-zone, bridges: 1}\n"
    "  - {index: 1, name: den-1, bridges: 1}\n"
    "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01", zone: sim-zone}\n'
    '  - {name: cpu-2, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02", zone: sim-zone}\n'
    '  - {name: cpu-3, ipmi_mac: "52:54:00:bc:00:03", data_mac: "52:54:00:da:00:03", zone: sim-zone}\n'
    '  - {name: zone1-cpu-5, ipmi_mac: "52:54:00:bc:00:05", data_mac: "52:54:00:da:00:05", zone: den-1}\n'
)


_SHRUNK_FLEET_MIXED = (
    "network: {name: t, cidr: 192.168.200.0/24, domain: t.local, bmc_cidr: 192.168.105.0/24}\n"
    "defaults: {cpus: 2, memory_mb: 2048, disk_gb: 40, bmc: {username: a, password: a}}\n"
    "zones:\n"
    "  - {index: 0, name: sim-zone, bridges: 1}\n"
    "  - {index: 1, name: den-1, bridges: 1}\n"
    "nodes:\n"
    '  - {name: cpu-1, ipmi_mac: "52:54:00:bc:00:01", data_mac: "52:54:00:da:00:01", zone: sim-zone}\n'
    '  - {name: cpu-2, ipmi_mac: "52:54:00:bc:00:02", data_mac: "52:54:00:da:00:02", zone: sim-zone}\n'
    '  - {name: onb-1, ipmi_mac: "52:54:00:bc:00:03", data_mac: "52:54:00:da:00:03", zone: den-1,\n'
    "     seed_as_server: false}\n"
)


def _assert_golden(name: str, sql: str) -> None:
    path = _GOLDEN_DIR / name
    if os.environ.get("UPDATE_SQL_GOLDENS"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(sql)
    assert sql == path.read_text()


@pytest.mark.parametrize(
    "gen,fleet_yaml,golden",
    [
        ("45-zone.py", _FIXTURE_FLEET_MULTI.read_text(), "45-zone.multi-zone.sql"),
        ("46-prefixes.py", _FIXTURE_FLEET_MULTI.read_text(), "46-prefixes.multi-zone.sql"),
        ("46-prefixes.py", _DHCP_FLEET, "46-prefixes.dhcp.sql"),
        ("46-prefixes.py", _RENDERED_NETPLAN_FLEET, "46-prefixes.rendered-netplan.sql"),
        ("50-devices.py", _RENDERED_NETPLAN_FLEET, "50-devices.rendered-netplan.sql"),
        ("50-devices.py", _OVERRIDES_FLEET, "50-devices.overrides.sql"),
        ("51-commissioning-devices.py", _OVERRIDES_FLEET, "51-commissioning-devices.overrides.sql"),
        ("52-baremetal-devices.py", _BAREMETAL_FLEET, "52-baremetal-devices.baremetal.sql"),
        ("55-dcim.py", _OVERRIDES_FLEET, "55-dcim.overrides.sql"),
    ],
)
def test_generated_sql_matches_golden(tmp_path, monkeypatch, gen, fleet_yaml, golden):
    monkeypatch.setenv("SIM_HOST_ARCH", "amd64")
    _pin_fleet(tmp_path, monkeypatch, fleet_yaml)
    _assert_golden(golden, _load(gen).generate())
