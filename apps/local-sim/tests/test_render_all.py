from pathlib import Path

import yaml
from local.render_all import render_fleet_to_dir

FLEET = {
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


def test_render_fleet_writes_domain_files(tmp_path):
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(yaml.safe_dump(FLEET))
    out_dir = tmp_path / "out"
    templates_dir = Path(__file__).parent.parent / "templates"

    render_fleet_to_dir(
        fleet_path,
        out_dir,
        templates_dir,
        overlay_root=Path("/var/lib/local/disks/overlays"),
        console_log_dir=tmp_path / "logs",
    )

    assert not (out_dir / "network.xml").exists()
    assert (out_dir / "domains" / "gpu-1.xml").exists()
    assert (out_dir / "domains" / "gpu-2.xml").exists()


def test_rendered_domain_references_correct_overlay(tmp_path):
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(yaml.safe_dump(FLEET))
    out_dir = tmp_path / "out"
    templates_dir = Path(__file__).parent.parent / "templates"

    render_fleet_to_dir(
        fleet_path,
        out_dir,
        templates_dir,
        overlay_root=Path("/var/lib/local/disks/overlays"),
        console_log_dir=tmp_path / "logs",
    )

    dom_xml = (out_dir / "domains" / "gpu-1.xml").read_text()
    assert "/var/lib/local/disks/overlays/gpu-1.img" in dom_xml


def test_rendered_domain_references_console_log(tmp_path):
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(yaml.safe_dump(FLEET))
    out_dir = tmp_path / "out"
    templates_dir = Path(__file__).parent.parent / "templates"

    render_fleet_to_dir(
        fleet_path,
        out_dir,
        templates_dir,
        overlay_root=Path("/var/lib/local/disks/overlays"),
        console_log_dir=Path("/var/log/local"),
    )

    dom_xml = (out_dir / "domains" / "gpu-1.xml").read_text()
    assert "/var/log/local/gpu-1.log" in dom_xml


def test_stale_domain_xml_removed_after_node_removal(tmp_path):
    fleet_path = tmp_path / "fleet.yml"
    fleet_path.write_text(yaml.safe_dump(FLEET))
    out_dir = tmp_path / "out"
    templates_dir = Path(__file__).parent.parent / "templates"

    render_fleet_to_dir(
        fleet_path,
        out_dir,
        templates_dir,
        overlay_root=Path("/var/lib/local/disks/overlays"),
        console_log_dir=tmp_path / "logs",
    )
    assert (out_dir / "domains" / "gpu-1.xml").exists()
    assert (out_dir / "domains" / "gpu-2.xml").exists()

    shrunk = {**FLEET, "nodes": [FLEET["nodes"][0]]}
    fleet_path.write_text(yaml.safe_dump(shrunk))
    render_fleet_to_dir(
        fleet_path,
        out_dir,
        templates_dir,
        overlay_root=Path("/var/lib/local/disks/overlays"),
        console_log_dir=tmp_path / "logs",
    )

    assert (out_dir / "domains" / "gpu-1.xml").exists()
    assert not (out_dir / "domains" / "gpu-2.xml").exists()
