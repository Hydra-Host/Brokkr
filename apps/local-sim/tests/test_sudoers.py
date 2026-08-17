from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest


def _dropin() -> Path | None:
    root = os.environ.get("DEVENV_ROOT")
    if not root:
        return None
    path = Path(root) / ".sudoers" / "brokkr-sim"
    return path if path.exists() else None


def _rendered() -> str:
    path = _dropin()
    if path is None:
        pytest.skip("$DEVENV_ROOT/.sudoers/brokkr-sim not materialized — enter the devenv shell first")
    return path.read_text().replace("__USER__", "brokkrtest")


def _grants(text: str) -> list[str]:
    return [line.split("NOPASSWD:", 1)[1].strip() for line in text.splitlines() if "NOPASSWD:" in line]


def test_generated_sudoers_passes_visudo():
    visudo = shutil.which("visudo") or ("/usr/sbin/visudo" if Path("/usr/sbin/visudo").exists() else None)
    if visudo is None:
        pytest.skip("visudo not available")
    with tempfile.NamedTemporaryFile("w", suffix=".sudoers", delete=False) as tmp:
        tmp.write(_rendered())
        tmp_path = tmp.name
    try:
        proc = subprocess.run([visudo, "-cf", tmp_path], capture_output=True, text=True)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    assert proc.returncode == 0, f"visudo rejected the generated drop-in:\n{proc.stdout}\n{proc.stderr}"


def test_probe_command_allowlisted():
    assert "/usr/bin/true" in _rendered()


def test_no_cmnd_aliases():
    for line in _rendered().splitlines():
        assert not line.strip().startswith("Cmnd_Alias"), (
            f"alias names are one namespace across all of /etc/sudoers.d, so two drop-ins "
            f"declaring this collide and sudo discards the second: {line.strip()!r}"
        )


def test_helper_is_the_privileged_entry_point():
    grants = _grants(_rendered())
    assert grants, "no NOPASSWD grant line"
    for grant in grants:
        cmds = [cmd.strip() for cmd in grant.split(",")]
        assert any(re.fullmatch(r"\S+/bin/brokkr-sim-priv", cmd) for cmd in cmds), cmds


def test_no_user_scoped_defaults():
    text = _rendered()
    assert "secure_path" not in text
    for line in text.splitlines():
        if line.strip().startswith("Defaults:"):
            raise AssertionError(f"user-scoped Defaults leaks onto general sudo: {line.strip()!r}")


def test_no_non_trailing_wildcards():
    for spec in _grants(_rendered()):
        for cmd in spec.split(","):
            cmd = cmd.strip()
            if "*" not in cmd:
                continue
            assert cmd.endswith(" *") and cmd.count("*") == 1, f"non-trailing wildcard in sudoers: {cmd!r}"


def test_retired_arg_globs_absent():
    text = _rendered()
    for gone in ("-c * -f *", "*lan.conf", "* dev lo", "* /opt/brokkr", "ipmi-sim/*", "chown *"):
        assert gone not in text, f"retired arg-glob still present: {gone!r}"


def test_platform_specific_rules():
    text = _rendered()
    if platform.system() == "Darwin":
        assert "--vmnet-mode=shared *" in text
        assert "socket_vmnet" in text
    else:
        assert "socket_vmnet" not in text


def test_no_unsafe_wildcards():
    text = _rendered()
    assert "sh -c" not in text
    assert "/nix/store/*" not in text


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
