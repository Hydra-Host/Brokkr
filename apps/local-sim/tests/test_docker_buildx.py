from __future__ import annotations

import inspect
import subprocess

import pytest
from local import grub_build, ipxe_build, process_utils, pxe


def _completed(returncode: int) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr="")


def test_a_zero_exit_satisfies_the_gate(monkeypatch):
    seen = {}

    def fake_run(*cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        return _completed(0)

    monkeypatch.setattr(process_utils, "run", fake_run)

    process_utils.ensure_docker_buildx()

    assert seen["cmd"] == ("docker", "buildx", "version")
    assert seen["kw"]["timeout"] == 20
    assert seen["kw"]["check"] is False


def test_a_nonzero_exit_raises_and_names_the_export_the_classic_builder_cannot_do(monkeypatch):
    monkeypatch.setattr(process_utils, "run", lambda *cmd, **kw: _completed(1))

    with pytest.raises(process_utils.DockerBuildxMissingError) as excinfo:
        process_utils.ensure_docker_buildx()

    assert "type=local" in str(excinfo.value)


def test_a_timeout_raises_the_same_error(monkeypatch):
    def fake_run(*cmd, **kw):
        raise subprocess.TimeoutExpired(list(cmd), 20)

    monkeypatch.setattr(process_utils, "run", fake_run)

    with pytest.raises(process_utils.DockerBuildxMissingError):
        process_utils.ensure_docker_buildx()


def test_the_error_stays_a_docker_unavailable_error():
    assert issubclass(process_utils.DockerBuildxMissingError, process_utils.DockerUnavailableError)


def test_pxe_gates_the_per_node_ipxe_build():
    assert "ensure_docker_buildx()" in inspect.getsource(pxe._compile_ipxe)


def test_ipxe_build_gates_the_bridge_export():
    assert "ensure_docker_buildx()" in inspect.getsource(ipxe_build.build_ipxe_binaries)


def test_grub_build_does_not_gate_on_buildx():
    assert "ensure_docker_buildx" not in inspect.getsource(grub_build.build_grub_binaries)
