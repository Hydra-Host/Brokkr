from local.render import render_bootptab_section
from local.schema import Fleet


def _fleet():
    return Fleet.model_validate(
        {
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
                "arch": "aarch64",
                "bmc": {"username": "admin", "password": "admin"},
            },
            "nodes": [
                {
                    "name": f"cpu-{i}",
                    "ipmi_mac": f"52:54:00:bc:00:0{i}",
                    "data_mac": f"52:54:00:da:00:0{i}",
                }
                for i in range(1, 5)
            ],
        }
    )


def test_render_section_wraps_markers():
    out = render_bootptab_section(_fleet(), 0)
    assert out.startswith("# >>> brokkr-slot-0\n")
    assert out.rstrip().endswith("# <<< brokkr-slot-0")
    assert "cpu-1\t1\t52:54:00:da:00:01\t192.168.200.10" in out
    assert "cpu-4\t1\t52:54:00:da:00:04\t192.168.200.13" in out


def test_render_section_uses_slot_marker():
    out = render_bootptab_section(_fleet(), 3)
    assert out.startswith("# >>> brokkr-slot-3\n")
    assert out.rstrip().endswith("# <<< brokkr-slot-3")
