import uuid

from local.derived import bmc_ip, node_ip, node_uuid


def test_node_ip_first_node():
    # gpu-1 → 10th host in the /24 → .10
    assert node_ip("192.168.122.0/24", 0) == "192.168.122.10"


def test_node_ip_offsets():
    assert node_ip("192.168.122.0/24", 1) == "192.168.122.11"
    assert node_ip("192.168.122.0/24", 9) == "192.168.122.19"


def test_bmc_ip_uses_same_offset_rule():
    assert bmc_ip("192.168.105.0/24", 0) == "192.168.105.10"
    assert bmc_ip("192.168.105.0/24", 1) == "192.168.105.11"


def test_bmc_ip_and_node_ip_are_independent_subnets():
    """gpu-1 has a data-plane IP and a separate OOB BMC IP."""
    assert node_ip("192.168.200.0/24", 0) == "192.168.200.10"
    assert bmc_ip("192.168.105.0/24", 0) == "192.168.105.10"


from local.derived import arch_url_segment  # noqa: E402


def test_arch_url_segment():
    assert arch_url_segment("x86_64") == "amd64"
    assert arch_url_segment("aarch64") == "arm64"


def test_node_uuid_is_deterministic_from_mac():
    u1 = node_uuid("52:54:00:da:00:01")
    u2 = node_uuid("52:54:00:da:00:01")
    assert u1 == u2


def test_node_uuid_differs_for_different_macs():
    u1 = node_uuid("52:54:00:da:00:01")
    u2 = node_uuid("52:54:00:da:00:02")
    assert u1 != u2


def test_node_uuid_is_valid_uuid():
    u = node_uuid("52:54:00:da:00:01")
    # Doesn't raise — proves it's a valid UUID string
    parsed = uuid.UUID(u)
    assert str(parsed) == u


from local.derived import bm_device_uuid, sim_device_uuid  # noqa: E402


def test_bm_device_uuid_is_deterministic_from_mac():
    assert bm_device_uuid("00:00:5e:00:53:b4") == bm_device_uuid("00:00:5e:00:53:b4")


def test_bm_device_uuid_is_case_insensitive():
    assert bm_device_uuid("00:00:5E:00:53:B4") == bm_device_uuid("00:00:5e:00:53:b4")


def test_bm_device_uuid_differs_per_mac():
    assert bm_device_uuid("00:00:5e:00:53:b4") != bm_device_uuid("00:00:5e:00:53:b5")


def test_bm_device_uuid_is_valid_uuid():
    u = bm_device_uuid("00:00:5e:00:53:b4")
    assert str(uuid.UUID(u)) == u


def test_bm_device_uuid_distinct_from_sim_device_uuid():
    assert bm_device_uuid("00:00:5e:00:53:b4") != sim_device_uuid(0)


def test_bm_device_uuid_cross_language_vector():
    assert bm_device_uuid("00:00:5e:00:53:b4") == "0e8c9981-6781-5e20-9d8e-a84ccf7f548a"


from local.derived import node_serial, node_wwn  # noqa: E402


def test_node_serial_is_deterministic_from_mac():
    """Bridge correlates lsblk output with NetBox storage_layouts via SCSI
    serial; the value must be stable so the seeded value matches reality."""
    assert node_serial("52:54:00:da:00:01") == node_serial("52:54:00:da:00:01")


def test_node_serial_differs_per_mac():
    s1 = node_serial("52:54:00:da:00:01")
    s2 = node_serial("52:54:00:da:00:02")
    assert s1 != s2


def test_node_wwn_is_naa_type_5_format():
    """Bridge expects SCSI WWN in NAA Type 5 form (16 hex digits, leading '5')
    matching what real SAS/SATA SSDs report via SCSI INQUIRY VPD page 0x83."""
    wwn = node_wwn("52:54:00:da:00:01")
    assert wwn.startswith("0x5")
    hex_part = wwn[2:]
    assert len(hex_part) == 16
    int(hex_part, 16)  # must parse as hex


def test_node_wwn_is_deterministic_from_mac():
    assert node_wwn("52:54:00:da:00:01") == node_wwn("52:54:00:da:00:01")


def test_node_wwn_differs_per_mac():
    assert node_wwn("52:54:00:da:00:01") != node_wwn("52:54:00:da:00:02")
