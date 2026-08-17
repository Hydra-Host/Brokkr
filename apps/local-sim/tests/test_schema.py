import local.config as cfg
import pytest
import yaml
from local.schema import BmcConfig, Fleet, Node, load_fleet, require_fleet
from pydantic import ValidationError

VALID_FLEET = {
    "network": {
        "name": "brokkr-net",
        "cidr": "192.168.200.0/24",
        "domain": "sim.local",
        "bmc_cidr": "192.168.105.0/24",
    },
    "defaults": {
        "cpus": 2,
        "memory_mb": 4096,
        "disk_gb": 40,
        "arch": "x86_64",
        "bmc": {"username": "admin", "password": "admin"},
    },
    "nodes": [
        {
            "name": "gpu-1",
            "ipmi_mac": "52:54:00:bc:00:01",
            "data_mac": "52:54:00:da:00:01",
        },
        {
            "name": "gpu-2",
            "ipmi_mac": "52:54:00:bc:00:02",
            "data_mac": "52:54:00:da:00:02",
        },
    ],
}


def test_valid_fleet_parses():
    fleet = Fleet.model_validate(VALID_FLEET)
    assert fleet.network.name == "brokkr-net"
    assert fleet.network.bmc_cidr == "192.168.105.0/24"
    assert len(fleet.nodes) == 2
    assert fleet.nodes[0].name == "gpu-1"


def test_node_inherits_defaults():
    fleet = Fleet.model_validate(VALID_FLEET)
    assert fleet.nodes[0].cpus == 2
    assert fleet.nodes[0].memory_mb == 4096
    assert fleet.nodes[0].arch == "x86_64"


def test_node_override_wins():
    data = {**VALID_FLEET}
    data["nodes"] = [
        {
            "name": "gpu-1",
            "ipmi_mac": "52:54:00:bc:00:01",
            "data_mac": "52:54:00:da:00:01",
            "memory_mb": 8192,
        },
    ]
    fleet = Fleet.model_validate(data)
    assert fleet.nodes[0].memory_mb == 8192
    assert fleet.nodes[0].cpus == 2


def test_duplicate_node_names_rejected():
    data = {**VALID_FLEET}
    data["nodes"] = [
        {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02"},
    ]
    with pytest.raises(ValidationError, match="duplicate.*name"):
        Fleet.model_validate(data)


def test_duplicate_data_macs_rejected():
    data = {**VALID_FLEET}
    data["nodes"] = [
        {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:01"},
    ]
    with pytest.raises(ValidationError, match="duplicate.*mac"):
        Fleet.model_validate(data)


def test_duplicate_ipmi_macs_rejected():
    data = {**VALID_FLEET}
    data["nodes"] = [
        {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:02"},
    ]
    with pytest.raises(ValidationError, match="duplicate.*mac"):
        Fleet.model_validate(data)


def test_ipmi_mac_and_data_mac_must_differ_on_same_node():
    data = {**VALID_FLEET}
    data["nodes"] = [
        {"name": "gpu-1", "ipmi_mac": "52:54:00:da:00:01", "data_mac": "52:54:00:da:00:01"},
    ]
    with pytest.raises(ValidationError, match="must differ"):
        Fleet.model_validate(data)


def test_invalid_mac_format_rejected():
    data = {**VALID_FLEET}
    data["nodes"] = [{"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "not-a-mac"}]
    with pytest.raises(ValidationError, match="mac"):
        Fleet.model_validate(data)


def test_macs_are_normalized_and_dedup_is_case_insensitive():
    fleet = Fleet.model_validate(
        {
            **VALID_FLEET,
            "nodes": [
                {"name": "gpu-1", "ipmi_mac": "52:54:00:BC:00:01", "data_mac": "52:54:00:DA:00:01"},
            ],
        }
    )
    assert fleet.nodes[0].ipmi_mac == "52:54:00:bc:00:01"
    assert fleet.nodes[0].data_mac == "52:54:00:da:00:01"


def test_missing_required_node_fields_rejected():
    base = {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}
    for missing_field in ("name", "ipmi_mac", "data_mac"):
        node = {**base}
        node.pop(missing_field)
        with pytest.raises(ValidationError):
            Fleet.model_validate({**VALID_FLEET, "nodes": [node]})


def test_missing_bmc_cidr_rejected():
    data = {**VALID_FLEET, "network": {**VALID_FLEET["network"]}}
    data["network"].pop("bmc_cidr")
    with pytest.raises(ValidationError, match="bmc_cidr"):
        Fleet.model_validate(data)


def test_default_bmc_is_not_shared_across_nodes():
    fleet = Fleet.model_validate(VALID_FLEET)
    nodes = fleet.nodes
    nodes[0].bmc.username = "hijacked"
    assert fleet.defaults.bmc.username == "admin"
    assert fleet.nodes[1].bmc.username == "admin"


def _fleet_with_name(name: str) -> dict:
    return {
        **VALID_FLEET,
        "nodes": [{"name": name, "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"}],
    }


@pytest.mark.parametrize(
    "bad_name",
    [
        "../evil",
        "a/b",
        "x\nchain http://attacker/x",
        "evil</name>",
        "; rm -rf /",
        "$(id)",
        "node 1",
        "..",
        "",
        ".hidden",
        "-flag",
        "x" * 65,
    ],
)
def test_malicious_node_name_rejected(bad_name: str):
    with pytest.raises(ValidationError, match="node name|name too long"):
        Fleet.model_validate(_fleet_with_name(bad_name))


def test_trailing_newline_node_name_rejected():
    with pytest.raises(ValidationError, match="node name"):
        Fleet.model_validate(_fleet_with_name("node-1\n"))


def test_normal_node_name_accepted():
    fleet = Fleet.model_validate(_fleet_with_name("node-01"))
    assert fleet.nodes[0].name == "node-01"
    for ok in ("cpu-1", "gpu-2", "node.example_1", "A"):
        assert Fleet.model_validate(_fleet_with_name(ok)).nodes[0].name == ok


def test_resolved_node_model_also_guards_name():
    with pytest.raises(ValidationError, match="node name"):
        Node(
            name="../evil",
            ipmi_mac="52:54:00:bc:00:01",
            data_mac="52:54:00:da:00:01",
            cpus=2,
            memory_mb=4096,
            disk_gb=40,
            arch="x86_64",
            bmc={"username": "admin", "password": "admin"},
            disks=[],
            passthrough=[],
            nics=[],
            data_mtu=None,
            ip=None,
            bmc_ip=None,
            console_port=None,
            zone="sim-zone",
            seed_as_server=True,
            network_type=None,
        )


def test_seed_as_server_defaults_true_and_carries_override():
    data = {
        **VALID_FLEET,
        "nodes": [{**VALID_FLEET["nodes"][0], "seed_as_server": False}, VALID_FLEET["nodes"][1]],
    }
    fleet = Fleet.model_validate(data)
    assert fleet.nodes[0].seed_as_server is False
    assert fleet.nodes[1].seed_as_server is True


def test_network_type_defaults_none_and_normalizes():
    data = {
        **VALID_FLEET,
        "nodes": [{**VALID_FLEET["nodes"][0], "network_type": " NAT "}, VALID_FLEET["nodes"][1]],
    }
    fleet = Fleet.model_validate(data)
    assert fleet.nodes[0].network_type == "nat"
    assert fleet.nodes[1].network_type is None


def test_empty_network_type_reads_as_unset():
    data = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "network_type": ""}]}
    assert Fleet.model_validate(data).nodes[0].network_type is None


@pytest.mark.parametrize("bad", ["bogus", "private", "Public!", 7])
def test_invalid_network_type_rejected(bad):
    data = {**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "network_type": bad}]}
    with pytest.raises(ValidationError, match="network_type"):
        Fleet.model_validate(data)


def test_no_zones_defaults_to_single_zone():
    fleet = Fleet.model_validate(VALID_FLEET)
    assert len(fleet.zones) == 1
    assert fleet.zones[0].index == 0
    assert fleet.zones[0].name == "sim-zone"
    assert fleet.zones[0].bridges == 1
    assert all(n.zone == "sim-zone" for n in fleet.nodes)


def test_rendered_netplan_defaults_off_and_allows_single_zone():
    assert Fleet.model_validate(VALID_FLEET).network.rendered_netplan is False
    data = {**VALID_FLEET, "network": {**VALID_FLEET["network"], "rendered_netplan": True}}
    assert Fleet.model_validate(data).network.rendered_netplan is True


def test_rendered_netplan_rejected_with_dhcp():
    """46-prefixes takes the DHCP branch (no Gateway) while 50-devices still clears the override."""
    data = {**VALID_FLEET, "network": {**VALID_FLEET["network"], "rendered_netplan": True, "dhcp": True}}
    with pytest.raises(ValidationError, match="mutually exclusive"):
        Fleet.model_validate(data)


def test_rendered_netplan_rejected_on_multi_zone():
    """Zones share an org and a cidr, so their primary prefixes are indistinguishable to the hub."""
    data = {
        **VALID_FLEET,
        "network": {**VALID_FLEET["network"], "rendered_netplan": True},
        "zones": [
            {"index": 0, "name": "phx-1", "bridges": 1},
            {"index": 1, "name": "den-1", "bridges": 1},
        ],
        "nodes": [
            {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01", "zone": "phx-1"},
            {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02", "zone": "den-1"},
        ],
    }
    with pytest.raises(ValidationError, match="single-zone"):
        Fleet.model_validate(data)


def test_multi_zone_assigns_nodes_and_bridges():
    data = {
        **VALID_FLEET,
        "zones": [
            {"index": 0, "name": "phx-1", "bridges": 1},
            {"index": 1, "name": "den-1", "bridges": 3},
        ],
        "nodes": [
            {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01", "zone": "phx-1"},
            {"name": "gpu-2", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02", "zone": "den-1"},
        ],
    }
    fleet = Fleet.model_validate(data)
    assert fleet.nodes[0].zone == "phx-1"
    assert fleet.nodes[1].zone == "den-1"
    assert fleet.zone_for("den-1").index == 1
    assert fleet.zone_for("den-1").bridges == 3


def test_multi_zone_requires_node_zone():
    data = {
        **VALID_FLEET,
        "zones": [
            {"index": 0, "name": "phx-1", "bridges": 1},
            {"index": 1, "name": "den-1", "bridges": 1},
        ],
        "nodes": [
            {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01"},
        ],
    }
    with pytest.raises(ValidationError, match="zone is required"):
        Fleet.model_validate(data)


def test_node_zone_must_reference_declared_zone():
    data = {
        **VALID_FLEET,
        "zones": [{"index": 0, "name": "phx-1", "bridges": 1}],
        "nodes": [
            {"name": "gpu-1", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01", "zone": "nope"},
        ],
    }
    with pytest.raises(ValidationError, match="not a declared zone"):
        Fleet.model_validate(data)


def test_duplicate_zone_index_and_name_rejected():
    for zones, match in (
        ([{"index": 0, "name": "a", "bridges": 1}, {"index": 0, "name": "b", "bridges": 1}], "duplicate zone index"),
        ([{"index": 0, "name": "a", "bridges": 1}, {"index": 1, "name": "a", "bridges": 1}], "duplicate zone name"),
    ):
        with pytest.raises(ValidationError, match=match):
            Fleet.model_validate(
                {
                    **VALID_FLEET,
                    "zones": zones,
                    "nodes": [
                        {
                            "name": "gpu-1",
                            "ipmi_mac": "52:54:00:bc:00:01",
                            "data_mac": "52:54:00:da:00:01",
                            "zone": "a",
                        },
                        {
                            "name": "gpu-2",
                            "ipmi_mac": "52:54:00:bc:00:02",
                            "data_mac": "52:54:00:da:00:02",
                            "zone": "a",
                        },
                    ],
                }
            )


def test_zone_bridges_and_index_bounds():
    with pytest.raises(ValidationError, match="bridges must be >= 1"):
        Fleet.model_validate({**VALID_FLEET, "zones": [{"index": 0, "name": "a", "bridges": 0}]})
    with pytest.raises(ValidationError, match="zone index must be 0..88"):
        Fleet.model_validate({**VALID_FLEET, "zones": [{"index": 89, "name": "a", "bridges": 1}]})


def test_zone_port_ordinal_tracks_bridge_blocks():
    single = Fleet.model_validate(VALID_FLEET)
    assert single.zone_port_ordinal("sim-zone") == 0
    assert single.zone_port_ordinal(None) == 0

    def _two(phx_bridges: int) -> Fleet:
        return Fleet.model_validate(
            {
                **VALID_FLEET,
                "zones": [
                    {"index": 0, "name": "phx", "bridges": phx_bridges},
                    {"index": 1, "name": "den", "bridges": 2},
                ],
                "nodes": [
                    {"name": "a", "ipmi_mac": "52:54:00:bc:00:01", "data_mac": "52:54:00:da:00:01", "zone": "phx"},
                    {"name": "b", "ipmi_mac": "52:54:00:bc:00:02", "data_mac": "52:54:00:da:00:02", "zone": "den"},
                ],
            }
        )

    assert _two(1).zone_port_ordinal("phx") == 0
    assert _two(1).zone_port_ordinal("den") == 1
    assert _two(2).zone_port_ordinal("den") == 2


def test_console_port_override_resolves_and_validates():
    overridden = {
        **VALID_FLEET,
        "nodes": [
            {**VALID_FLEET["nodes"][0], "console_port": 9400},
            VALID_FLEET["nodes"][1],
        ],
    }
    fleet = Fleet.model_validate(overridden)
    assert fleet.nodes[0].console_port == 9400
    assert fleet.nodes[1].console_port is None

    with pytest.raises(ValidationError, match="console_port must be 1024..65535"):
        Fleet.model_validate({**VALID_FLEET, "nodes": [{**VALID_FLEET["nodes"][0], "console_port": 80}]})

    with pytest.raises(ValidationError, match="console_port 9400 collides"):
        Fleet.model_validate(
            {
                **VALID_FLEET,
                "nodes": [
                    {**VALID_FLEET["nodes"][0], "console_port": 9400},
                    {**VALID_FLEET["nodes"][1], "console_port": 9400},
                ],
            }
        )

    with pytest.raises(ValidationError, match="console_port 9300 collides"):
        Fleet.model_validate(
            {
                **VALID_FLEET,
                "nodes": [
                    VALID_FLEET["nodes"][0],
                    {**VALID_FLEET["nodes"][1], "console_port": 9300},
                ],
            }
        )


BM_NODE = {"name": "bm-1", "pxe_mac": "00:00:5e:00:53:a1", "bmc_ip": "10.0.0.20", "bmc_mac": "00:00:5e:00:53:c1"}
VALID_BM = {
    "mode": "baremetal",
    "network": VALID_FLEET["network"],
    "defaults": VALID_FLEET["defaults"],
    "nodes": [],
    "baremetal": {"iface": "eno1", "iface_ip": "10.0.0.5", "arch": "amd64", "nodes": [dict(BM_NODE)]},
}


def test_legacy_yaml_without_mode_defaults_to_vm():
    fleet = Fleet.model_validate(VALID_FLEET)
    assert fleet.mode == "vm"
    assert fleet.baremetal_raw is None
    assert fleet.bm_nodes == []


def test_vm_mode_forbids_baremetal_block():
    data = {**VALID_FLEET, "baremetal": {"iface": "eno1", "iface_ip": "10.0.0.5", "nodes": [dict(BM_NODE)]}}
    with pytest.raises(ValidationError, match="only allowed when mode"):
        Fleet.model_validate(data)


def test_baremetal_mode_parses_and_resolves_defaults():
    fleet = Fleet.model_validate(VALID_BM)
    assert fleet.mode == "baremetal"
    assert len(fleet.nodes) == 0
    assert fleet.baremetal_raw.iface == "eno1"
    bm = fleet.bm_nodes
    assert len(bm) == 1
    assert bm[0].arch == "amd64"
    assert bm[0].zone == "sim-zone"
    assert bm[0].system_id is None


def test_baremetal_node_arch_override_wins():
    data = {
        **VALID_BM,
        "baremetal": {**VALID_BM["baremetal"], "arch": "amd64", "nodes": [{**BM_NODE, "arch": "arm64"}]},
    }
    assert Fleet.model_validate(data).bm_nodes[0].arch == "arm64"


def test_baremetal_mode_requires_baremetal_block():
    with pytest.raises(ValidationError, match="requires a 'baremetal' block"):
        Fleet.model_validate({"mode": "baremetal", "network": VALID_FLEET["network"], "nodes": []})


def test_baremetal_mode_requires_at_least_one_node():
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": []}}
    with pytest.raises(ValidationError, match="at least one baremetal node"):
        Fleet.model_validate(data)


def test_baremetal_bmc_mac_is_required():
    node = {k: v for k, v in BM_NODE.items() if k != "bmc_mac"}
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": [node]}}
    with pytest.raises(ValidationError, match="bmc_mac"):
        Fleet.model_validate(data)


def test_baremetal_macs_normalized_lowercase():
    node = {**BM_NODE, "pxe_mac": "00:00:5E:00:53:A1", "bmc_mac": "00:00:5E:00:53:C1"}
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": [node]}}
    bm = Fleet.model_validate(data).bm_nodes[0]
    assert bm.pxe_mac == "00:00:5e:00:53:a1"
    assert bm.bmc_mac == "00:00:5e:00:53:c1"


def test_baremetal_network_type_defaults_none_and_normalizes():
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": [{**BM_NODE, "network_type": "NAT"}]}}
    assert Fleet.model_validate(data).bm_nodes[0].network_type == "nat"
    assert Fleet.model_validate(VALID_BM).bm_nodes[0].network_type is None


def test_baremetal_invalid_network_type_rejected():
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": [{**BM_NODE, "network_type": "private"}]}}
    with pytest.raises(ValidationError, match="network_type"):
        Fleet.model_validate(data)


def test_baremetal_invalid_bmc_ip_rejected():
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": [{**BM_NODE, "bmc_ip": "not-an-ip"}]}}
    with pytest.raises(ValidationError, match="invalid IPv4"):
        Fleet.model_validate(data)


def test_baremetal_invalid_iface_rejected():
    for bad in ("", "eth0!bad", "x" * 16):
        data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "iface": bad}}
        with pytest.raises(ValidationError):
            Fleet.model_validate(data)


def test_baremetal_duplicate_node_names_rejected():
    nodes = [
        dict(BM_NODE),
        {**BM_NODE, "pxe_mac": "00:00:5e:00:53:a2", "bmc_ip": "10.0.0.21", "bmc_mac": "00:00:5e:00:53:c2"},
    ]
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": nodes}}
    with pytest.raises(ValidationError, match="duplicate baremetal node name"):
        Fleet.model_validate(data)


def test_baremetal_duplicate_pxe_mac_rejected():
    nodes = [dict(BM_NODE), {**BM_NODE, "name": "bm-2", "bmc_ip": "10.0.0.21", "bmc_mac": "00:00:5e:00:53:c2"}]
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": nodes}}
    with pytest.raises(ValidationError, match="duplicate mac"):
        Fleet.model_validate(data)


def test_baremetal_pxe_and_bmc_mac_pools_are_disjoint():
    nodes = [
        dict(BM_NODE),
        {"name": "bm-2", "pxe_mac": "00:00:5e:00:53:a2", "bmc_ip": "10.0.0.21", "bmc_mac": BM_NODE["pxe_mac"]},
    ]
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": nodes}}
    with pytest.raises(ValidationError, match="duplicate mac"):
        Fleet.model_validate(data)


def test_baremetal_duplicate_bmc_ip_rejected():
    nodes = [dict(BM_NODE), {**BM_NODE, "name": "bm-2", "pxe_mac": "00:00:5e:00:53:a2", "bmc_mac": "00:00:5e:00:53:c2"}]
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": nodes}}
    with pytest.raises(ValidationError, match="bmc_ip.*collides"):
        Fleet.model_validate(data)


def test_baremetal_node_zone_must_reference_declared_zone():
    data = {**VALID_BM, "baremetal": {**VALID_BM["baremetal"], "nodes": [{**BM_NODE, "zone": "nope"}]}}
    with pytest.raises(ValidationError, match="not a declared zone"):
        Fleet.model_validate(data)


def test_baremetal_node_zone_references_multi_zone():
    data = {
        **VALID_BM,
        "zones": [{"index": 0, "name": "phx", "bridges": 1}, {"index": 1, "name": "den", "bridges": 1}],
        "baremetal": {**VALID_BM["baremetal"], "nodes": [{**BM_NODE, "zone": "den"}]},
    }
    assert Fleet.model_validate(data).bm_nodes[0].zone == "den"


def test_nodes_property_is_cached():
    fleet = Fleet.model_validate(VALID_FLEET)
    assert fleet.nodes is fleet.nodes
    assert fleet.zones is fleet.zones


def test_bmc_credentials_reject_lanconf_metacharacters():
    data = {**VALID_FLEET, "defaults": {**VALID_FLEET["defaults"], "bmc": {"username": 'ad"min', "password": "admin"}}}
    with pytest.raises(ValidationError, match="lan.conf"):
        Fleet.model_validate(data)


def test_bmc_credentials_accept_safe_charset():
    data = {
        **VALID_FLEET,
        "defaults": {**VALID_FLEET["defaults"], "bmc": {"username": "admin-1", "password": "p_w.d-2"}},
    }
    fleet = Fleet.model_validate(data)
    assert fleet.nodes[0].bmc.username == "admin-1"
    assert fleet.nodes[0].bmc.password == "p_w.d-2"


def test_bmc_bad_password_not_echoed_in_direct_validation_error():
    secret = 'sekret"injection'
    with pytest.raises(ValidationError) as exc:
        BmcConfig.model_validate({"username": "admin", "password": secret})
    assert secret not in str(exc.value)


def test_bmc_bad_password_not_echoed_in_validation_error():
    secret = 'sekret"injection'
    data = {**VALID_FLEET, "defaults": {**VALID_FLEET["defaults"], "bmc": {"username": "admin", "password": secret}}}
    with pytest.raises(ValidationError) as exc:
        Fleet.model_validate(data)
    assert secret not in str(exc.value)


def test_bmc_password_field_rejects_lanconf_metacharacters():
    data = {**VALID_FLEET, "defaults": {**VALID_FLEET["defaults"], "bmc": {"username": "admin", "password": 'pw"d'}}}
    with pytest.raises(ValidationError, match="invalid BMC credential"):
        Fleet.model_validate(data)


def test_bmc_credential_over_32_chars_rejected():
    data = {**VALID_FLEET, "defaults": {**VALID_FLEET["defaults"], "bmc": {"username": "admin", "password": "a" * 33}}}
    with pytest.raises(ValidationError, match="invalid BMC credential"):
        Fleet.model_validate(data)


def test_bmc_empty_credential_rejected():
    data = {**VALID_FLEET, "defaults": {**VALID_FLEET["defaults"], "bmc": {"username": "admin", "password": ""}}}
    with pytest.raises(ValidationError, match="invalid BMC credential"):
        Fleet.model_validate(data)


def test_bm_nodes_property_is_cached():
    fleet = Fleet.model_validate(VALID_BM)
    assert fleet.bm_nodes is fleet.bm_nodes


def test_load_fleet_reads_and_validates_the_configured_path(tmp_path, monkeypatch):
    path = tmp_path / "fleet.yml"
    path.write_text(yaml.safe_dump(VALID_FLEET))
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(path))
    cfg.get_settings.cache_clear()
    fleet = require_fleet()
    assert [n.name for n in fleet.nodes] == ["gpu-1", "gpu-2"]


def test_require_fleet_raises_when_the_path_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(tmp_path / "absent.yml"))
    cfg.get_settings.cache_clear()
    assert load_fleet() is None
    with pytest.raises(RuntimeError, match=r"no fleet\.yml"):
        require_fleet()
