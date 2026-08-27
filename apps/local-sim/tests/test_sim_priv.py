from __future__ import annotations

import os
import pwd
import re
import shlex
import shutil
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[3] / "devenv" / "pkgs" / "sim-priv.sh"

pytestmark = pytest.mark.skipif(
    not HELPER.exists() or shutil.which("bash") is None or os.name != "posix",
    reason="sim-priv.sh / bash not available",
)


def _env(**extra: str) -> dict[str, str]:
    user = pwd.getpwuid(os.getuid()).pw_name
    env = {
        **os.environ,
        "SUDO_USER": user,
        "SUDO_UID": str(os.getuid()),
        "SUDO_GID": str(os.getgid()),
    }
    env.update(extra)
    return env


def _run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(HELPER), *args],
        capture_output=True,
        text=True,
        env=env or _env(),
    )


@pytest.fixture
def home_work() -> Iterator[Path]:
    base = Path.home() / ".cache" / f"brokkr-sim-priv-test-{os.getpid()}"
    base.mkdir(parents=True, exist_ok=True)
    try:
        yield base
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_unknown_verb_is_default_deny():
    p = _run("bogus")
    assert p.returncode == 64
    assert "unknown verb" in p.stderr


def test_no_verb_is_default_deny():
    p = _run()
    assert p.returncode == 64


def test_noop_verb_succeeds_silently():
    p = _run("noop")
    assert p.returncode == 0, p.stderr
    assert p.stdout == ""
    assert p.stderr == ""


def test_noop_verb_rejects_arguments():
    p = _run("noop", "extra")
    assert p.returncode == 64
    assert "usage:" in p.stderr


@pytest.mark.parametrize(
    "args",
    [
        ("console-readable",),
        ("ipmi-purge",),
        ("svc-start",),
        ("lo-add",),
        ("bootptab-section-install", "brokkr-slot-0"),
        ("dropin-current",),
        ("dropin-current", "brokkr-sim-aaaaaaaaaaaa"),
    ],
)
def test_wrong_arity_rejected(args):
    p = _run(*args)
    assert p.returncode == 64
    assert "usage:" in p.stderr


@pytest.mark.parametrize("marker", ["bad;marker", "bad/marker", "bad marker", "a,b", ""])
def test_bootptab_section_marker_charset_enforced(marker):
    p = _run("bootptab-section-remove", marker)
    assert p.returncode == 64
    assert "bad marker" in p.stderr
    p = _run("bootptab-section-install", marker, "/tmp/section")
    assert p.returncode == 64
    assert "bad marker" in p.stderr


def test_extra_args_rejected_no_passthrough():
    p = _run("console-readable", "/tmp/a", "--reference=/etc/shadow")
    assert p.returncode == 64


@pytest.mark.parametrize(
    "args",
    [
        ("ipmi-purge", "/etc"),
        ("console-readable", "/etc/hosts"),
        ("console-prepare", "/etc/hosts"),
        ("bootptab-install", "/etc/hosts"),
        ("vmnet-sock-rm", "/tmp/socket_vmnet.x.sock"),
    ],
)
def test_paths_outside_home_refused(args):
    p = _run(*args)
    assert p.returncode != 0
    assert "refuse" in p.stderr or "does not exist" in p.stderr


def test_symlink_leaf_refused(home_work):
    link = home_work / "evil.log"
    link.symlink_to("/etc/hosts")
    p = _run("console-readable", str(link))
    assert p.returncode != 0
    assert "symlink" in p.stderr


@pytest.mark.parametrize("ip", ["999.1.1.1", "10.0.0", "10.0.0.1.2", "-9", "a.b.c.d"])
def test_invalid_ipv4_refused(ip):
    p = _run("lo-add", ip)
    assert p.returncode != 0
    assert "invalid IPv4" in p.stderr


def test_svc_start_allowlist():
    assert _run("svc-start", "libvirtd@evil").returncode != 0
    assert _run("svc-start", "sshd").returncode != 0
    assert "not allowed" in _run("svc-start", "sshd").stderr


def test_vmnet_stop_rejects_non_socket_vmnet_pid(home_work):
    pidf = home_work / "socket_vmnet.gpu-1.pid"
    pidf.write_text(f"{os.getpid()}\n")
    sock = home_work / "socket_vmnet.gpu-1.sock"
    p = _run("vmnet-stop", str(pidf), str(sock))
    assert p.returncode != 0
    assert "not socket_vmnet" in p.stderr


def test_vmnet_stop_rejects_bad_pid(home_work):
    pidf = home_work / "socket_vmnet.gpu-1.pid"
    pidf.write_text("-1\n")
    sock = home_work / "socket_vmnet.gpu-1.sock"
    p = _run("vmnet-stop", str(pidf), str(sock))
    assert p.returncode != 0
    assert "bad pid" in p.stderr


def test_console_readable_grants_read(home_work):
    log = home_work / "state" / "logs" / "gpu-1.log"
    log.parent.mkdir(parents=True)
    log.write_text("data")
    log.chmod(0o600)
    p = _run("console-readable", str(log))
    assert p.returncode == 0, p.stderr
    assert (log.stat().st_mode & 0o044) == 0o044


def test_console_prepare_truncates_and_grants_read(home_work):
    log = home_work / "state" / "logs" / "gpu-2.log"
    log.parent.mkdir(parents=True)
    log.write_text("stale console output")
    p = _run("console-prepare", str(log))
    assert p.returncode == 0, p.stderr
    assert log.stat().st_size == 0
    assert (log.stat().st_mode & 0o044) == 0o044


def test_ipmi_purge_removes_only_node_dir(home_work):
    node = home_work / "state" / "ipmi-sim" / "gpu-1"
    (node / "state").mkdir(parents=True)
    (node / "lan.conf").write_text("x")
    p = _run("ipmi-purge", str(node))
    assert p.returncode == 0, p.stderr
    assert not node.exists()
    assert node.parent.exists()


def test_ipmi_purge_rejects_wrong_parent(home_work):
    notnode = home_work / "state" / "notipmi" / "gpu-1"
    notnode.mkdir(parents=True)
    p = _run("ipmi-purge", str(notnode))
    assert p.returncode != 0
    assert "ipmi-sim" in p.stderr


def test_ipmi_launch_builds_fixed_template_and_execs(home_work):
    stub = home_work / "ipmi_sim_stub"
    stub.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
    stub.chmod(0o755)
    cfg = home_work / "state" / "ipmi-sim" / "gpu-3"
    (cfg / "state").mkdir(parents=True)
    (cfg / "lan.conf").write_text("name x")
    (cfg / "sim.emu").write_text("mc")
    p = _run("ipmi-launch", str(cfg), env=_env(IPMI_SIM=str(stub)))
    assert p.returncode == 0, p.stderr
    assert p.stdout.splitlines() == ["-c", f"{cfg}/lan.conf", "-f", f"{cfg}/sim.emu", "-s", f"{cfg}/state", "-n"]


@pytest.mark.skipif(sys.platform == "darwin", reason="bpf-grant is accepted on macOS")
def test_bpf_grant_rejected_on_linux():
    p = _run("bpf-grant")
    assert p.returncode != 0
    assert "macos-only" in p.stderr


@pytest.mark.skipif(sys.platform == "darwin", reason="bpf-revoke is accepted on macOS")
def test_bpf_revoke_rejected_on_linux():
    p = _run("bpf-revoke")
    assert p.returncode != 0
    assert "macos-only" in p.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="arity check fires after macOS guard")
@pytest.mark.parametrize("verb", ["bpf-grant", "bpf-revoke"])
def test_bpf_extra_args_rejected(verb):
    p = _run(verb, "extra")
    assert p.returncode == 64
    assert "usage:" in p.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="SUDO_UID check fires after macOS guard")
@pytest.mark.parametrize("verb", ["bpf-grant", "bpf-revoke"])
def test_bpf_bad_sudo_uid_rejected(verb):
    p = _run(verb, env=_env(SUDO_UID="notanumber"))
    assert p.returncode != 0
    assert "bad SUDO_UID" in p.stderr


@pytest.mark.skipif(sys.platform == "darwin", reason="vmnet-hostip is accepted on macOS")
def test_vmnet_hostip_rejected_on_linux():
    p = _run("vmnet-hostip", "10.0.0.1")
    assert p.returncode != 0
    assert "macos-only" in p.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="arity check fires after macOS guard")
@pytest.mark.parametrize("args", [(), ("10.0.0.1", "255.255.255.0", "extra")])
def test_vmnet_hostip_wrong_arity(args):
    p = _run("vmnet-hostip", *args)
    assert p.returncode == 64
    assert "usage:" in p.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="validation fires after macOS guard")
def test_vmnet_hostip_invalid_gateway():
    p = _run("vmnet-hostip", "999.1.1.1")
    assert p.returncode != 0
    assert "invalid" in p.stderr


@pytest.mark.skipif(sys.platform != "darwin", reason="validation fires after macOS guard")
def test_vmnet_hostip_invalid_netmask():
    p = _run("vmnet-hostip", "10.0.0.1", "not-a-mask")
    assert p.returncode != 0
    assert "invalid" in p.stderr


_IS_LINUX = sys.platform.startswith("linux")


def test_cap_net_bind_wrong_arity_rejected(home_work):
    p = _run("cap-net-bind", str(home_work / "node"))
    assert p.returncode == 64
    assert "usage:" in p.stderr


@pytest.mark.skipif(not _IS_LINUX, reason="cap-net-bind is linux-only")
def test_cap_net_bind_rejects_non_executable_src(home_work):
    src = home_work / "not-exec"
    src.write_text("x")
    src.chmod(0o644)
    p = _run("cap-net-bind", str(src), str(home_work / "baremetal" / "node"))
    assert p.returncode != 0
    assert "not an executable" in p.stderr


@pytest.mark.skipif(not _IS_LINUX, reason="cap-net-bind is linux-only")
def test_cap_net_bind_rejects_dest_outside_home(home_work):
    src = home_work / "node"
    src.write_text("#!/bin/sh\n")
    src.chmod(0o755)
    p = _run("cap-net-bind", str(src), "/tmp/brokkr-cap-net-bind-escape/node")
    assert p.returncode != 0
    assert "outside" in p.stderr


@pytest.mark.skipif(not _IS_LINUX, reason="cap-net-bind is linux-only")
def test_cap_net_bind_traversal_dest_creates_nothing_outside_home(home_work):
    src = home_work / "node"
    src.write_text("#!/bin/sh\n")
    src.chmod(0o755)
    escape_root = Path(f"/tmp/brokkr-cap-net-bind-traversal-{os.getpid()}")
    shutil.rmtree(escape_root, ignore_errors=True)
    rel = os.path.relpath(escape_root / "pwn", home_work)
    dest = home_work / rel / "node"
    p = _run("cap-net-bind", str(src), str(dest))
    assert p.returncode != 0
    assert "outside" in p.stderr
    assert not escape_root.exists(), "root created a directory outside $HOME before the check"


def test_cap_net_bind_deep_prefix_traversal_creates_nothing_outside_home(home_work):
    src = home_work / "node"
    src.write_text("#!/bin/sh\n")
    src.chmod(0o755)
    (home_work / "a" / "b").mkdir(parents=True)
    escape_root = Path(f"/tmp/brokkr-cap-net-bind-deep-{os.getpid()}")
    shutil.rmtree(escape_root, ignore_errors=True)
    up = os.path.relpath(escape_root, home_work / "a" / "b" / "NEW")
    dest = home_work / "a" / "b" / "NEW" / up / "pwn" / "node"
    p = _run("cap-net-bind", str(src), str(dest))
    assert p.returncode != 0
    assert "outside" in p.stderr
    assert not escape_root.exists(), "root created a directory outside $HOME via a deep-prefix `..` chain"


@pytest.mark.skipif(not _IS_LINUX, reason="cap-net-bind is linux-only")
def test_cap_net_bind_rejects_symlink_dest(home_work):
    src = home_work / "node"
    src.write_text("#!/bin/sh\n")
    src.chmod(0o755)
    (home_work / "baremetal").mkdir()
    dest = home_work / "baremetal" / "node"
    dest.symlink_to(src)
    p = _run("cap-net-bind", str(src), str(dest))
    assert p.returncode != 0
    assert "symlink" in p.stderr


@pytest.mark.requires_host
@pytest.mark.skipif(
    not _IS_LINUX or os.geteuid() != 0 or shutil.which("setcap") is None,
    reason="cap-net-bind accept path needs root + setcap (real privileged op)",
)
def test_cap_net_bind_copies_and_setcaps(home_work):
    src = home_work / "node"
    src.write_text("#!/bin/sh\ntrue\n")
    src.chmod(0o755)
    dest = home_work / "baremetal" / "node"
    p = _run("cap-net-bind", str(src), str(dest))
    assert p.returncode == 0, p.stderr
    assert dest.is_file() and not dest.is_symlink()
    getcap = shutil.which("getcap")
    if getcap is not None:
        caps = subprocess.run([getcap, str(dest)], capture_output=True, text=True)
        assert "cap_net_bind_service" in caps.stdout
        assert "cap_net_raw" in caps.stdout


def test_bootptab_section_delete_expression_is_line_anchored():
    src = HELPER.read_text()
    assert src.count("/# >>> $marker\\$/,/# <<< $marker\\$/d") == 2


def _sed_delete_expr(marker: str) -> str:
    m = re.search(r'"\$SED" "([^"]+)" "\$cur"', HELPER.read_text())
    assert m, f"no bootptab sed delete expression in {HELPER}"
    return m.group(1).replace("$marker", marker).replace("\\$", "$")


def _bootptab_header() -> str:
    m = re.search(r"printf '([^']+)' >\"\$work\"", HELPER.read_text())
    assert m, f"no bootptab header printf in {HELPER}"
    return subprocess.run(
        ["bash", "-c", 'printf "$1"', "_", m.group(1)],
        capture_output=True,
        text=True,
    ).stdout


def _section_survives_pattern() -> str:
    m = re.search(r'"\$GREP" -q \'([^\']+)\'', HELPER.read_text())
    assert m, f"no remaining-section grep pattern in {HELPER}"
    return m.group(1)


def _sed(expr: str, text: str) -> str:
    return subprocess.run(["sed", expr], input=text, capture_output=True, text=True).stdout


def _install_section(existing: str | None, marker: str, section: str) -> str:
    work = _bootptab_header() if existing is None else _sed(_sed_delete_expr(marker), existing)
    return work + section


def _remove_section(existing: str, marker: str) -> str | None:
    work = _sed(_sed_delete_expr(marker), existing)
    kept = subprocess.run(
        ["grep", "-q", _section_survives_pattern()],
        input=work,
        capture_output=True,
        text=True,
    )
    return work if kept.returncode == 0 else None


_HEADER = "# Generated by local fleet:up. Do not edit by hand.\n%%\n"
_TWO_SECTIONS = _HEADER + "# >>> brokkr-slot-0\na\n# <<< brokkr-slot-0\n# >>> brokkr-slot-1\nb\n# <<< brokkr-slot-1\n"


def test_bootptab_section_delete_preserves_prefix_colliding_sections():
    content = _HEADER + "# >>> brokkr-slot-1\na\n# <<< brokkr-slot-1\n# >>> brokkr-slot-10\nb\n# <<< brokkr-slot-10\n"
    out = _sed(_sed_delete_expr("brokkr-slot-1"), content)
    assert "brokkr-slot-10" in out
    assert "\nb\n" in out
    assert "\na\n" not in out


def test_bootptab_install_replaces_only_its_own_section():
    out = _install_section(_TWO_SECTIONS, "brokkr-slot-0", "# >>> brokkr-slot-0\nA2\n# <<< brokkr-slot-0\n")
    assert "A2" in out
    assert "\na\n" not in out
    assert "# >>> brokkr-slot-1\nb\n# <<< brokkr-slot-1" in out
    assert out.startswith(_HEADER)


def test_bootptab_install_appends_when_section_absent():
    existing = _HEADER + "# >>> brokkr-slot-1\nb\n# <<< brokkr-slot-1\n"
    section = "# >>> brokkr-slot-2\nc\n# <<< brokkr-slot-2\n"
    assert _install_section(existing, "brokkr-slot-2", section) == existing + section


def test_bootptab_install_seeds_header_when_file_absent():
    section = "# >>> brokkr-slot-0\na\n# <<< brokkr-slot-0\n"
    assert _install_section(None, "brokkr-slot-0", section) == _HEADER + section


def test_bootptab_remove_drops_only_its_own_section():
    out = _remove_section(_TWO_SECTIONS, "brokkr-slot-1")
    assert out is not None
    assert "brokkr-slot-1" not in out
    assert "# >>> brokkr-slot-0\na\n# <<< brokkr-slot-0" in out


def test_bootptab_remove_of_missing_section_is_noop():
    existing = _HEADER + "# >>> brokkr-slot-0\na\n# <<< brokkr-slot-0\n"
    assert _remove_section(existing, "brokkr-slot-2") == existing


def test_bootptab_remove_of_last_section_deletes_the_file():
    existing = _HEADER + "# >>> brokkr-slot-0\na\n# <<< brokkr-slot-0\n"
    assert _remove_section(existing, "brokkr-slot-0") is None


def _lock_tool_and_argv() -> tuple[str, list[str]]:
    src = HELPER.read_text()
    var, candidates = (
        ("flock", ["/usr/bin/flock", "/bin/flock", "/run/current-system/sw/bin/flock"])
        if _IS_LINUX
        else ("lockf", ["/usr/bin/lockf"])
    )
    m = re.search(rf'"\${var}" (.+?) \|\| die', src)
    assert m, f"no ${var} invocation found in {HELPER}"
    tool = next((c for c in candidates if os.access(c, os.X_OK)), "")
    return tool, shlex.split(m.group(1))


def _with_zero_timeout(argv: list[str]) -> list[str]:
    out = list(argv)
    for flag in ("-t", "-w"):
        if flag in out:
            out[out.index(flag) + 1] = "0"
    return out


_LOCK_TOOL, _LOCK_ARGV = _lock_tool_and_argv()


@pytest.mark.skipif(not _LOCK_TOOL, reason="platform lock tool not installed")
def test_bootptab_lock_invocation_acquires_and_holds(tmp_path):
    lk = tmp_path / "bootptab.lk"
    ready = tmp_path / "acquired"
    script = 'exec 9>"$1"; ready="$2"; shift 2; "$@" || exit 9; : >"$ready"; sleep 30'
    holder = subprocess.Popen(
        ["bash", "-c", script, "_", str(lk), str(ready), _LOCK_TOOL, *_LOCK_ARGV],
        cwd=tmp_path,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not ready.exists():
            if holder.poll() is not None:
                break
            time.sleep(0.05)
        assert ready.exists(), (
            f"{_LOCK_TOOL} {shlex.join(_LOCK_ARGV)} failed to acquire the lock: "
            f"rc={holder.poll()} stderr={holder.communicate()[1] if holder.poll() is not None else ''}"
        )

        contender = subprocess.run(
            [
                "bash",
                "-c",
                'exec 9>"$1"; shift; exec "$@"',
                "_",
                str(lk),
                _LOCK_TOOL,
                *_with_zero_timeout(_LOCK_ARGV),
            ],
            cwd=tmp_path,
            capture_output=True,
            text=True,
        )
        assert contender.returncode != 0, "lock was not held after the tool returned"
    finally:
        holder.kill()
        holder.wait()


@pytest.mark.parametrize(
    "name",
    [
        "../shadow",
        "brokkr-sim/../../etc/shadow",
        "brokkr-sim;id",
        "brokkr-sim aaa",
        "brokkr-sim.rev",
        "shadow",
        "",
    ],
)
def test_dropin_current_name_charset_enforced(name, home_work):
    cand = home_work / "render"
    cand.write_text("x\n")
    p = _run("dropin-current", name, str(cand))
    assert p.returncode == 64
    assert "bad drop-in name" in p.stderr


def test_dropin_current_candidate_outside_home_refused():
    p = _run("dropin-current", "brokkr-sim-aaaaaaaaaaaa", "/etc/hosts")
    assert p.returncode == 1
    assert "outside" in p.stderr


def test_dropin_current_candidate_must_be_a_regular_file(home_work):
    d = home_work / "adir"
    d.mkdir(exist_ok=True)
    p = _run("dropin-current", "brokkr-sim-aaaaaaaaaaaa", str(d))
    assert p.returncode == 1
    assert "not a regular file" in p.stderr


def test_dropin_current_absent_dropin_is_not_current(home_work):
    cand = home_work / "render"
    cand.write_text("x\n")
    p = _run("dropin-current", "brokkr-sim-zzzzzzzzzzzz", str(cand))
    assert p.returncode == 3
    assert p.stdout == ""


def test_dropin_current_never_exits_one(home_work):
    cand = home_work / "render"
    cand.write_text("x\n")
    p = _run("dropin-current", "brokkr-sim-zzzzzzzzzzzz", str(cand))
    assert p.returncode != 1


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
