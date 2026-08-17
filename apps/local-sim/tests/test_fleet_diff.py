import argparse
import json

from local import fleet as fleetmod


def _write_fleet(tmp_path):
    p = tmp_path / "fleet.yml"
    p.write_text(
        "network: {name: brokkr-net, cidr: 192.168.200.0/24, domain: sim.local, "
        "bmc_cidr: 192.168.105.0/24}\n"
        "defaults: {cpus: 2, memory_mb: 4096, disk_gb: 40, arch: x86_64}\n"
        "nodes:\n"
        "  - {name: cpu-1, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01'}\n"
    )
    return p


def test_cmd_diff_exits_2_on_drift(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    src = _write_fleet(tmp_path)
    monkeypatch.setenv("LOCAL_FLEET_PATH", str(src))

    rc = fleetmod.cmd_diff(argparse.Namespace(source=str(src)))
    out = json.loads(capsys.readouterr().out)
    assert rc == 2  # no manifest yet → drift
    assert out["summary"]["added"] == 1


def test_cmd_diff_exits_0_when_in_sync(tmp_path, monkeypatch, capsys):
    import yaml
    from local import applied
    from local.schema import Fleet

    monkeypatch.setenv("LOCAL_STATE", str(tmp_path))
    src = _write_fleet(tmp_path)
    applied.write(Fleet.model_validate(yaml.safe_load(src.read_text())))

    rc = fleetmod.cmd_diff(argparse.Namespace(source=str(src)))
    json.loads(capsys.readouterr().out)
    assert rc == 0
