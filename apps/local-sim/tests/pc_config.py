from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess
from collections.abc import Iterator
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
_STACK_OVERLAY = REPO_ROOT / "stack.local.nix"

_STORE_HASH_RE = re.compile(r"/nix/store/[a-z0-9]{32}-")
_RUNTIME_DIR_RE = re.compile(r"/run/user/\d+/devenv-[0-9a-f]+")
_MACOS_RUNTIME_DIR_RE = re.compile(r"/tmp/devenv-[0-9a-f]+")
_ARCH_RE = re.compile(r"^(DISCOVERY_ARCHITECTURES=)(amd64|arm64)$", re.M)
_AT_REST_KEY_RE = re.compile(r"^(BRIDGE_AT_REST_KEY=).*$")
_FLEET_SOURCE_RE = re.compile(r"^(LOCAL_FLEET_SOURCE=)(/nix/store/[a-z0-9]{32}-\S*fleet\.yml)$")


def render_pc_config() -> dict:
    out = subprocess.run(
        [
            "devenv",
            "build",
            "--refresh-eval-cache",
            "process.managers.process-compose.configFile",
        ],
        capture_output=True,
        text=True,
        timeout=600,
        cwd=REPO_ROOT,
        env=dict(os.environ),
    )
    if out.returncode != 0:
        raise AssertionError(f"devenv build failed:\n{out.stderr}")
    cfg_path = json.loads(out.stdout)["process.managers.process-compose.configFile"]
    return yaml.safe_load(Path(cfg_path).read_text())


@contextlib.contextmanager
def with_overlay(overlay_nix: str | None) -> Iterator[None]:
    had = _STACK_OVERLAY.exists()
    prior = _STACK_OVERLAY.read_text() if had else None
    try:
        if overlay_nix is None:
            if had:
                _STACK_OVERLAY.unlink()
        else:
            _STACK_OVERLAY.write_text(overlay_nix)
        yield
    finally:
        if prior is not None:
            _STACK_OVERLAY.write_text(prior)
        elif _STACK_OVERLAY.exists():
            _STACK_OVERLAY.unlink()


def render_under_overlay(overlay_nix: str | None) -> dict:
    with with_overlay(overlay_nix):
        return render_pc_config()


def flip_diff(overlay_a: str | None, overlay_b: str | None) -> set[str]:
    cfg_a = render_under_overlay(overlay_a)
    cfg_b = render_under_overlay(overlay_b)
    _assert_task_file_shared(cfg_a, cfg_b)
    procs = set(cfg_a["processes"]) | set(cfg_b["processes"])
    diff: set[str] = set()
    for name in procs:
        a = cfg_a["processes"].get(name)
        b = cfg_b["processes"].get(name)
        if a is None or b is None or normalize_process(a) != normalize_process(b):
            diff.add(name)
    return diff


_TASK_FILE_RE = re.compile(r"--task-file (\S+)")


def _assert_task_file_shared(cfg_a: dict, cfg_b: dict) -> None:
    def task_files(cfg: dict) -> set[str]:
        out: set[str] = set()
        for p in cfg["processes"].values():
            m = _TASK_FILE_RE.search(p.get("command", ""))
            if m:
                out.add(m.group(1))
        return out

    a, b = task_files(cfg_a), task_files(cfg_b)
    assert a == b, f"--task-file store path diverged between evals: {a} != {b}"


def _fleet_source_digest(m: re.Match[str]) -> str:
    path = Path(m.group(2))
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        return f"{m.group(1)}$FLEET"
    return f"{m.group(1)}fleet:{digest}"


def normalize_str(s: str) -> str:
    s = s.replace(str(REPO_ROOT), "$REPO")
    s = s.replace(str(Path.home()), "$HOME")
    s = _FLEET_SOURCE_RE.sub(_fleet_source_digest, s)
    s = _STORE_HASH_RE.sub("/nix/store/$HASH-", s)
    s = _RUNTIME_DIR_RE.sub("/run/user/$UID/devenv-$ID", s)
    s = _MACOS_RUNTIME_DIR_RE.sub("/run/user/$UID/devenv-$ID", s)
    s = _ARCH_RE.sub(r"\1$ARCH", s)
    s = _AT_REST_KEY_RE.sub(r"\1$AT_REST_KEY", s)
    return s


def normalize_env_list(env: list[str]) -> list[str]:
    return sorted(normalize_str(e) for e in env)


_EXTENDED_FIELDS = (
    "readiness_probe",
    "liveness_probe",
    "shutdown",
    "availability",
    "namespace",
    "description",
    "working_dir",
    "log_location",
    "replicas",
    "disabled",
    "is_elevated",
    "entrypoint",
    "extensions",
)


def normalize_process(proc: dict) -> dict:
    out = {
        "command": normalize_str(proc.get("command", "")),
        "environment": normalize_env_list(proc.get("environment", [])),
        "depends_on": normalize_str(json.dumps(proc.get("depends_on", {}), sort_keys=True)),
    }
    for field in _EXTENDED_FIELDS:
        out[field] = normalize_str(json.dumps(proc.get(field), sort_keys=True))
    return out


_PROC_TARGET_RE = re.compile(r"(devenv:processes:\S+)\s*$")


def _resolve_process_exec(cfg: dict, name: str) -> str:
    pc_cmd = cfg["processes"][name].get("command", "")
    tf = _TASK_FILE_RE.search(pc_cmd)
    tgt = _PROC_TARGET_RE.search(pc_cmd)
    if not tf or not tgt:
        return ""
    try:
        tasks = json.loads(Path(tf.group(1)).read_text())
        script = next(t["command"] for t in tasks if t.get("name") == tgt.group(1))
        return Path(script).read_text()
    except (OSError, StopIteration, KeyError, json.JSONDecodeError):
        return ""


def snapshot_process(cfg: dict, name: str) -> dict:
    return normalize_process(cfg["processes"][name]) | {
        "exec": normalize_str(_resolve_process_exec(cfg, name)),
    }
