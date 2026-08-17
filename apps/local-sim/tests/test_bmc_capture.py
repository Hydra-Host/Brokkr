from __future__ import annotations

from collections.abc import Callable

from local import bmc_capture


def _fake_get(docs: dict[str, object], calls: list[str] | None = None) -> Callable[[str, str], object | None]:
    def get(url: str, _auth_header: str) -> object | None:
        if calls is not None:
            calls.append(url)
        for path, doc in docs.items():
            if url.endswith(path):
                return doc
        return None

    return get


def test_capture_redfish_writes_normal_ref_under_out(tmp_path, monkeypatch):
    docs = {
        "/redfish/v1": {"@odata.id": "/redfish/v1", "Systems": {"@odata.id": "/redfish/v1/Systems"}},
        "/redfish/v1/Systems": {"@odata.id": "/redfish/v1/Systems"},
    }
    monkeypatch.setattr(bmc_capture, "_redfish_get", _fake_get(docs))

    count = bmc_capture.capture_redfish("https://bmc", "Basic x", tmp_path, trim=False)

    assert count == 2
    assert (tmp_path / "redfish/v1/index.json").exists()
    assert (tmp_path / "redfish/v1/Systems/index.json").exists()


def test_capture_redfish_skips_escaping_ref(tmp_path, monkeypatch):
    docs = {
        "/redfish/v1": {"@odata.id": "/redfish/v1", "Evil": {"@odata.id": "/redfish/../../../../etc/evil"}},
        "/redfish/../../../../etc/evil": {"@odata.id": "/redfish/x"},
    }
    calls: list[str] = []
    monkeypatch.setattr(bmc_capture, "_redfish_get", _fake_get(docs, calls))

    count = bmc_capture.capture_redfish("https://bmc", "Basic x", tmp_path, trim=False)

    assert count == 1
    assert (tmp_path / "redfish/v1/index.json").exists()
    assert not (tmp_path / "../../../../etc/evil").resolve().exists()
    assert not any("etc/evil" in url for url in calls)


def test_capture_ipmi_passes_password_via_env_not_argv(tmp_path, monkeypatch):
    runs: list[tuple[list[str], dict[str, str]]] = []

    class _Result:
        returncode = 0
        stdout = "ok"
        stderr = ""

    def fake_run(argv, capture_output, text, timeout, env):
        runs.append((argv, env))
        return _Result()

    monkeypatch.setattr(bmc_capture.subprocess, "run", fake_run)

    ok = bmc_capture.capture_ipmi("192.168.105.10", "admin", "s3cr3t", 623, tmp_path)

    assert ok == len(bmc_capture.IPMI_SWEEP)
    for argv, env in runs:
        assert "-E" in argv
        assert "-P" not in argv
        assert "s3cr3t" not in argv
        assert env["IPMI_PASSWORD"] == "s3cr3t"
