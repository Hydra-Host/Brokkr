from __future__ import annotations

import http.client
import json
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.requires_host

sys.path.insert(0, str(Path(__file__).resolve().parent))

_skip = pytest.mark.skipif(shutil.which("process-compose") is None, reason="process-compose not on PATH")

_READINESS = {
    "exec": {"command": "true"},
    "initial_delay_seconds": 1,
    "period_seconds": 2,
    "timeout_seconds": 1,
    "success_threshold": 1,
    "failure_threshold": 3,
}


def _proc(env: list[str]) -> dict:
    return {
        "command": "sleep 100000",
        "environment": env,
        "availability": {"restart": "on_failure", "max_restarts": 5},
        "namespace": "grp",
        "readiness_probe": dict(_READINESS),
        "depends_on": {},
    }


def _config(beta_env: str = "1") -> dict:
    return {
        "version": "0.5",
        "processes": {
            "alpha": _proc(["MARK=static"]),
            "beta": _proc([f"FOO={beta_env}"]),
        },
    }


def _pc(*args: str, sock: Path, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["process-compose", *args, "-U", "-u", str(sock)],
        capture_output=True,
        text=True,
        cwd=str(cwd),
        env={"PC_DISABLE_DOTENV": "1", "PATH": _path()},
        timeout=60,
    )


def _path() -> str:
    import os

    return os.environ.get("PATH", "")


def _list(sock: Path, cwd: Path) -> list[dict]:
    out = _pc("process", "list", "-o", "json", sock=sock, cwd=cwd)
    return json.loads(out.stdout)


def _pids(sock: Path, cwd: Path) -> dict[str, int]:
    return {p["name"]: p["pid"] for p in _list(sock, cwd)}


def _get_info(sock: Path, name: str) -> dict:
    conn = http.client.HTTPConnection("localhost")
    conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.sock.connect(str(sock))
    try:
        conn.request("GET", f"/process/info/{name}")
        resp = conn.getresponse()
        return json.loads(resp.read())
    finally:
        conn.close()


_RESTART_ENUM = {0: "no", 1: "always", 2: "on_failure", 3: "exit_on_failure"}


def _map_probe(p: dict | None) -> dict | None:
    if p is None:
        return None
    out: dict = {}
    if p.get("Exec"):
        out["exec"] = {"command": p["Exec"].get("Command", "")}
        wd = p["Exec"].get("WorkingDir", "")
        if wd:
            out["exec"]["working_dir"] = wd
    if p.get("HttpGet"):
        h = p["HttpGet"]
        out["http_get"] = {
            "host": h.get("Host"),
            "path": h.get("Path"),
            "port": h.get("Port"),
            "scheme": h.get("Scheme"),
        }
    out["initial_delay_seconds"] = p.get("InitialDelay", 0)
    out["period_seconds"] = p.get("PeriodSeconds", 0)
    out["timeout_seconds"] = p.get("TimeoutSeconds", 0)
    out["success_threshold"] = p.get("SuccessThreshold", 0)
    out["failure_threshold"] = p.get("FailureThreshold", 0)
    return out


def _info_to_rendered(info: dict) -> dict:
    rp = info.get("RestartPolicy") or {}
    availability = None
    if rp:
        availability = {"restart": _RESTART_ENUM.get(rp.get("Restart")), "max_restarts": rp.get("MaxRestarts", 0)}
    sd = info.get("ShutDownParams") or {}
    shutdown = None
    if any(sd.get(k) for k in ("ShutDownCommand", "ShutDownTimeout", "Signal", "ParentOnly")):
        shutdown = {}
        if sd.get("Signal"):
            shutdown["signal"] = sd["Signal"]
        if sd.get("ShutDownTimeout"):
            shutdown["timeout_seconds"] = sd["ShutDownTimeout"]
        if sd.get("ShutDownCommand"):
            shutdown["command"] = sd["ShutDownCommand"]
    return {
        "command": info.get("Command", ""),
        "environment": info.get("Environment") or [],
        "depends_on": info.get("DependsOn") or {},
        "readiness_probe": _map_probe(info.get("ReadinessProbe")),
        "liveness_probe": _map_probe(info.get("LivenessProbe")),
        "shutdown": shutdown,
        "availability": availability,
        "namespace": info.get("Namespace") or None,
        "description": info.get("Description") or None,
        "working_dir": info.get("WorkingDir") or None,
        "log_location": info.get("LogLocation") or None,
        "replicas": info.get("Replicas") if info.get("Replicas") not in (0, 1) else None,
        "disabled": info.get("Disabled") or None,
        "is_elevated": info.get("IsElevated") or None,
        "entrypoint": info.get("Entrypoint"),
        "extensions": info.get("Extensions"),
    }


@pytest.fixture
def daemon(tmp_path):
    cwd = tmp_path
    (cwd / ".env").write_text("LEAKVAR=fromdotenv\n")
    cfg_path = cwd / "pc.yaml"
    cfg_path.write_text(yaml.safe_dump(_config()))
    sock = cwd / "pc.sock"

    proc = subprocess.Popen(
        [
            "process-compose",
            "up",
            "-f",
            str(cfg_path),
            "-U",
            "-u",
            str(sock),
            "--disable-dotenv",
            "-D",
            "--keep-project",
            "-t=false",
        ],
        cwd=str(cwd),
        env={"PC_DISABLE_DOTENV": "1", "PATH": _path()},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if _pc("process", "list", "-o", "json", sock=sock, cwd=cwd).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise AssertionError("pc daemon did not become reachable within 30s")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if all(p["status"] == "Running" for p in _list(sock, cwd)):
                break
            time.sleep(0.5)
        yield sock, cwd, cfg_path
    finally:
        _pc("down", sock=sock, cwd=cwd)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


@_skip
def test_identical_update_restarts_nothing(daemon):
    sock, cwd, cfg = daemon
    before = _pids(sock, cwd)
    out = _pc("project", "update", "-f", str(cfg), sock=sock, cwd=cwd)
    assert out.returncode == 0, out.stderr
    time.sleep(3)
    after = _pids(sock, cwd)
    changed = {n for n in before if before[n] != after.get(n)}
    assert changed == set(), f"identical update restarted {changed} (stock 1.64.1 vars bug — needs the patched pc)"
    assert "no processes were updated" in out.stdout.lower(), out.stdout


@_skip
def test_single_process_env_edit_restarts_only_that_process(daemon):
    sock, cwd, cfg = daemon
    edited = cwd / "pc.edited.yaml"
    edited.write_text(yaml.safe_dump(_config(beta_env="2")))
    before = _pids(sock, cwd)
    out = _pc("project", "update", "-f", str(edited), sock=sock, cwd=cwd)
    assert out.returncode == 0, out.stderr
    time.sleep(3)
    after = _pids(sock, cwd)
    changed = {n for n in before if before[n] != after.get(n)}
    assert changed == {"beta"}, f"expected only beta to restart, got {changed}"


@_skip
def test_info_self_consistent_with_rendered_config(daemon):
    from pc_config import _EXTENDED_FIELDS, normalize_process

    sock, cwd, cfg = daemon
    rendered = yaml.safe_load(cfg.read_text())["processes"]
    surface = ("depends_on", *_EXTENDED_FIELDS)
    for name in ("alpha", "beta"):
        info = _get_info(sock, name)
        live = normalize_process(_info_to_rendered(info))
        expected = normalize_process(rendered[name])
        diff = {k for k in surface if live.get(k) != expected.get(k)}
        assert diff == set(), f"{name}: /process/info diverged from rendered config on {diff}"


@_skip
def test_dotenv_alignment_keeps_planted_env_out_of_config(daemon):
    sock, cwd, cfg = daemon
    for name in ("alpha", "beta"):
        info = _get_info(sock, name)
        env = info.get("Environment") or []
        assert not any("fromdotenv" in e for e in env), f"{name} env leaked .env value: {env}"
