import io
import re

import pytest
from local.logger import Logger, log


@pytest.fixture
def cap_logger():
    out, err = io.StringIO(), io.StringIO()
    return Logger(stdout=out, stderr=err), out, err


def _strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


def test_info_writes_arrow_prefix_to_stdout(cap_logger):
    lg, out, err = cap_logger
    lg.info("starting fleet:init")
    assert _strip_ansi(out.getvalue()) == "==> starting fleet:init\n"
    assert err.getvalue() == ""


def test_success_writes_two_space_arrow_to_stdout(cap_logger):
    lg, out, err = cap_logger
    lg.success("cached sim-gpu-1")
    assert out.getvalue() == "  → cached sim-gpu-1\n"
    assert err.getvalue() == ""


def test_detail_writes_indented_unstyled(cap_logger):
    lg, out, err = cap_logger
    lg.detail("ttl=86400s")
    assert out.getvalue() == "  ttl=86400s\n"
    assert err.getvalue() == ""


def test_warn_writes_WARN_prefix_to_stdout(cap_logger):
    lg, out, err = cap_logger
    lg.warn("bridge is unreachable, falling back to cache")
    assert _strip_ansi(out.getvalue()) == "WARN: bridge is unreachable, falling back to cache\n"
    assert err.getvalue() == ""


def test_error_writes_ERROR_prefix_to_stderr(cap_logger):
    lg, out, err = cap_logger
    lg.error("fleet.yml not found")
    assert _strip_ansi(err.getvalue()) == "ERROR: fleet.yml not found\n"
    assert out.getvalue() == ""


def test_skip_writes_skip_prefix_to_stderr(cap_logger):
    lg, out, err = cap_logger
    lg.skip("gpu-2: no ARP entry yet")
    assert err.getvalue() == "  skip gpu-2: no ARP entry yet\n"
    assert out.getvalue() == ""


def test_module_singleton_is_a_Logger():
    assert isinstance(log, Logger)
