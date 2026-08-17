from __future__ import annotations

import io
import json
import urllib.error
from types import SimpleNamespace

import pytest
from local import bm_power
from local.bm_power import BmPowerError, RedfishAuthError, _RedfishUnusable
from local.commission_baremetal import BareMetalNode, BmcCreds
from local.derived import bm_device_uuid

_PXE_MAC = "00:00:5e:00:53:b4"
_EXPECTED_UUID = "0e8c9981-6781-5e20-9d8e-a84ccf7f548a"


def _node(name: str = "bench-1", pxe_mac: str = _PXE_MAC, system_id: str | None = None) -> BareMetalNode:
    return BareMetalNode(
        name=name,
        pxe_mac=pxe_mac,
        bmc_ip="198.51.100.250",
        bmc_mac="aa:bb:cc:dd:ee:ff",
        arch="amd64",
        system_id=system_id,
    )


_CREDS = BmcCreds(username="admin", password="s3cret")


def test_shared_vector_is_stable():
    assert bm_device_uuid(_PXE_MAC) == _EXPECTED_UUID


def test_resolve_by_name():
    nodes = [_node("bench-1"), _node("bench-2", pxe_mac="aa:aa:aa:aa:aa:aa")]
    assert bm_power.resolve_bm_node(nodes, "bench-2").name == "bench-2"


def test_resolve_by_pxe_mac_case_insensitive():
    nodes = [_node("bench-1")]
    assert bm_power.resolve_bm_node(nodes, _PXE_MAC.upper()).name == "bench-1"


def test_resolve_unknown_lists_names_and_macs():
    nodes = [_node("bench-1")]
    with pytest.raises(BmPowerError) as exc:
        bm_power.resolve_bm_node(nodes, "nope")
    assert "bench-1" in str(exc.value)
    assert _PXE_MAC in str(exc.value)


def test_assert_target_passes_on_match():
    bm_power.assert_target(_node(), _EXPECTED_UUID)


def test_assert_target_fails_closed_on_mismatch():
    with pytest.raises(BmPowerError) as exc:
        bm_power.assert_target(_node(), "00000000-0000-0000-0000-000000000000")
    assert "wrong-machine" in str(exc.value)
    assert "reconcile" in str(exc.value)


class _FakeResp:
    def __init__(self, body: dict):
        self._raw = json.dumps(body).encode()

    def read(self) -> bytes:
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_SYSTEM_DOC = {
    "PowerState": "On",
    "Boot": {
        "BootSourceOverrideEnabled@Redfish.AllowableValues": ["Once", "Continuous"],
        "BootSourceOverrideTarget": "Pxe",
        "BootSourceOverrideEnabled": "Continuous",
    },
    "Actions": {"#ComputerSystem.Reset": {"ResetType@Redfish.AllowableValues": ["On", "ForceRestart", "ForceOff"]}},
}


class _RedfishRecorder:
    def __init__(self, system_doc: dict | None = None):
        self.requests: list[tuple[str, str, dict | None]] = []
        self.system_doc = system_doc if system_doc is not None else _SYSTEM_DOC

    def __call__(self, req, timeout=None, context=None):
        method = req.get_method()
        url = req.full_url
        body = json.loads(req.data) if req.data else None
        self.requests.append((method, url, body))
        if url.endswith("/redfish/v1/Systems"):
            return _FakeResp({"Members": [{"@odata.id": "/redfish/v1/Systems/1"}]})
        if method == "GET":
            return _FakeResp(self.system_doc)
        return _FakeResp({})


def _install_redfish(monkeypatch, recorder: _RedfishRecorder):
    monkeypatch.setattr(bm_power.urllib.request, "urlopen", recorder)


def test_set_boot_pxe_patches_continuous_when_allowable(monkeypatch):
    rec = _RedfishRecorder()
    _install_redfish(monkeypatch, rec)
    auth = bm_power._auth_header(_CREDS)
    bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/1", 30)
    patch = next(b for (m, _u, b) in rec.requests if m == "PATCH")
    assert patch == {
        "Boot": {
            "BootSourceOverrideTarget": "Pxe",
            "BootSourceOverrideMode": "UEFI",
            "BootSourceOverrideEnabled": "Continuous",
        }
    }


def test_set_boot_pxe_falls_back_to_once(monkeypatch):
    doc = {
        **_SYSTEM_DOC,
        "Boot": {
            "BootSourceOverrideEnabled@Redfish.AllowableValues": ["Once"],
            "BootSourceOverrideTarget": "Pxe",
            "BootSourceOverrideEnabled": "Once",
        },
    }
    rec = _RedfishRecorder(system_doc=doc)
    _install_redfish(monkeypatch, rec)
    auth = bm_power._auth_header(_CREDS)
    bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/1", 30)
    patch = next(b for (m, _u, b) in rec.requests if m == "PATCH")
    assert patch["Boot"]["BootSourceOverrideEnabled"] == "Once"


def test_set_boot_pxe_sends_if_match_from_etag(monkeypatch):
    seen: list[tuple[str, str, str | None]] = []

    def _urlopen(req, timeout=None, context=None):
        seen.append((req.get_method(), req.full_url, req.get_header("If-match")))
        if req.get_method() == "GET":
            return _FakeResp({**_SYSTEM_DOC, "@odata.etag": '"1785789879"'})
        return _FakeResp({})

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _urlopen)
    auth = bm_power._auth_header(_CREDS)
    bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/Self", 30)
    patches = [(m, u, h) for (m, u, h) in seen if m == "PATCH"]
    assert len(patches) == 1
    assert patches[0][2] == '"1785789879"'


def test_set_boot_pxe_follows_future_state_uri(monkeypatch):
    pending = "/redfish/v1/Systems/Self/SD"
    patched: list[str] = []
    ami_message = f"Support of this Operation for Boot Properties is moved to FutureState URI({pending})"

    def _urlopen(req, timeout=None, context=None):
        url = req.full_url
        if req.get_method() == "GET":
            return _FakeResp({**_SYSTEM_DOC, "@odata.etag": '"abc"'})
        if url.endswith(pending):
            patched.append(url)
            return _FakeResp({})
        raise urllib.error.HTTPError(
            url,
            400,
            "Bad Request",
            {},
            io.BytesIO(json.dumps({"error": {"@Message.ExtendedInfo": [{"Message": ami_message}]}}).encode()),
        )

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _urlopen)
    auth = bm_power._auth_header(_CREDS)
    bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/Self", 30)
    assert patched == [f"https://198.51.100.250{pending}"]


def test_set_boot_pxe_reads_back_from_the_resource_that_accepted_the_write(monkeypatch):
    pending = "/redfish/v1/Systems/Self/SD"
    current_state = {"Boot": {"BootSourceOverrideTarget": "None", "BootSourceOverrideEnabled": "Disabled"}}
    gets: list[str] = []

    def _urlopen(req, timeout=None, context=None):
        url = req.full_url
        if req.get_method() == "GET":
            gets.append(url)
            if url.endswith(pending):
                return _FakeResp({**_SYSTEM_DOC, "@odata.etag": '"abc"'})
            return _FakeResp({**current_state, "@odata.etag": '"abc"'})
        if url.endswith(pending):
            return _FakeResp({})
        raise urllib.error.HTTPError(
            url,
            400,
            "Bad Request",
            {},
            io.BytesIO(json.dumps({"error": {"Message": f"moved to FutureState URI({pending})"}}).encode()),
        )

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _urlopen)
    auth = bm_power._auth_header(_CREDS)
    bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/Self", 30)
    assert gets[-1] == f"https://198.51.100.250{pending}"


def test_set_boot_pxe_400_without_future_state_falls_back(monkeypatch):
    def _urlopen(req, timeout=None, context=None):
        if req.get_method() == "GET":
            return _FakeResp(_SYSTEM_DOC)
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(b'{"error":{}}'))

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _urlopen)
    auth = bm_power._auth_header(_CREDS)
    with pytest.raises(bm_power._RedfishUnusable):
        bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/Self", 30)


def test_bm_reset_selects_first_allowable_reset_type(monkeypatch):
    rec = _RedfishRecorder()
    _install_redfish(monkeypatch, rec)
    auth = bm_power._auth_header(_CREDS)
    state = bm_power.bm_reset_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/1", "reset", 30)
    assert state == "On"
    post = next(b for (m, _u, b) in rec.requests if m == "POST")
    assert post == {"ResetType": "ForceRestart"}


def test_base_url_is_443_not_8443(monkeypatch):
    rec = _RedfishRecorder()
    _install_redfish(monkeypatch, rec)
    auth = bm_power._auth_header(_CREDS)
    bm_power.bm_reset_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/1", "on", 30)
    for _m, url, _b in rec.requests:
        assert url.startswith("https://198.51.100.250/")
        assert ":8443" not in url


def test_auth_header_is_basic():
    header = bm_power._auth_header(_CREDS)
    assert header.startswith("Basic ")
    import base64

    assert base64.b64decode(header.split(" ", 1)[1]).decode() == "admin:s3cret"


def test_powercycle_forceoff_on_fallback(monkeypatch):
    doc = {
        **_SYSTEM_DOC,
        "PowerState": "Off",
        "Actions": {"#ComputerSystem.Reset": {"ResetType@Redfish.AllowableValues": ["On", "ForceOff"]}},
    }
    rec = _RedfishRecorder(system_doc=doc)
    _install_redfish(monkeypatch, rec)
    monkeypatch.setattr(bm_power.time, "sleep", lambda _s: None)
    auth = bm_power._auth_header(_CREDS)
    bm_power.bm_reset_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/1", "powercycle", 30)
    posts = [b for (m, _u, b) in rec.requests if m == "POST"]
    assert {"ResetType": "ForceOff"} in posts
    assert {"ResetType": "On"} in posts


def _http_error(code: int):
    def _raise(req, timeout=None, context=None):
        raise urllib.error.HTTPError(req.full_url, code, "denied", {}, io.BytesIO(b""))

    return _raise


def test_redfish_401_is_auth_error_seal_reseed(monkeypatch):
    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _http_error(401))
    auth = bm_power._auth_header(_CREDS)
    with pytest.raises(RedfishAuthError) as exc:
        bm_power._resolve_system_path("https://198.51.100.250", auth, _node(), 30)
    assert "seal" in str(exc.value).lower()


def test_redfish_403_is_auth_error(monkeypatch):
    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _http_error(403))
    auth = bm_power._auth_header(_CREDS)
    with pytest.raises(RedfishAuthError):
        bm_power._resolve_system_path("https://198.51.100.250", auth, _node(), 30)


def test_boot_into_live_401_does_not_fall_back_to_ipmi(monkeypatch):
    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _http_error(401))
    ipmi_called: list[bool] = []
    monkeypatch.setattr(bm_power, "set_boot_pxe_ipmi", lambda *a, **k: ipmi_called.append(True))
    monkeypatch.setattr(bm_power, "bm_reset_ipmi", lambda *a, **k: ipmi_called.append(True))
    with pytest.raises(RedfishAuthError):
        bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="on", timeout=30)
    assert ipmi_called == []


def test_boot_into_live_falls_back_to_ipmi_on_unreachable(monkeypatch):
    def _refused(req, timeout=None, context=None):
        raise urllib.error.URLError(ConnectionRefusedError("connection refused"))

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _refused)

    ipmi_calls: list[list[str]] = []

    def _fake_run(argv, capture_output=None, text=None, timeout=None, check=None):
        ipmi_calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(bm_power.subprocess, "run", _fake_run)

    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="on", timeout=30)
    assert state == "ipmi:on"
    assert any("bootdev" in a and "pxe" in a for a in ipmi_calls)
    assert any(a[-3:] == ["chassis", "power", "on"] for a in ipmi_calls)
    bootdev_idx = next(i for i, a in enumerate(ipmi_calls) if "bootdev" in a)
    power_idx = next(i for i, a in enumerate(ipmi_calls) if a[-2:] == ["power", "on"])
    assert bootdev_idx < power_idx


def test_boot_into_live_falls_back_to_ipmi_on_non_auth_bmpowererror(monkeypatch):
    def _empty_members(*a, **k):
        raise bm_power.BmPowerError("/redfish/v1/Systems has no Members")

    monkeypatch.setattr(bm_power, "_resolve_system_path", _empty_members)

    ipmi_calls: list[list[str]] = []

    def _fake_run(argv, capture_output=None, text=None, timeout=None, check=None):
        ipmi_calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(bm_power.subprocess, "run", _fake_run)

    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="on", timeout=30)
    assert state == "ipmi:on"
    assert any("bootdev" in a and "pxe" in a for a in ipmi_calls)
    assert any(a[-3:] == ["chassis", "power", "on"] for a in ipmi_calls)


def test_ipmi_argv_matches_app_lanplus_shape():
    argv = bm_power._ipmitool_base(_node(), _CREDS)
    assert argv[0] == "ipmitool"
    assert "-I" in argv and argv[argv.index("-I") + 1] == "lanplus"
    assert "-H" in argv and argv[argv.index("-H") + 1] == "198.51.100.250"
    assert "-U" in argv and argv[argv.index("-U") + 1] == "admin"
    assert "-P" in argv and argv[argv.index("-P") + 1] == "s3cret"


def test_ssl_timeout_treated_as_unreachable(monkeypatch):
    import ssl as _ssl

    def _tls_fail(req, timeout=None, context=None):
        raise _ssl.SSLError("handshake failure")

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _tls_fail)
    auth = bm_power._auth_header(_CREDS)
    with pytest.raises(_RedfishUnusable):
        bm_power._resolve_system_path("https://198.51.100.250", auth, _node(), 30)


def test_redfish_428_falls_back_to_ipmi(monkeypatch):
    def _http_428(req, timeout=None, context=None):
        if req.get_method() == "GET":
            return _FakeResp({"Members": [{"@odata.id": "/redfish/v1/Systems/Self"}]})
        raise urllib.error.HTTPError(req.full_url, 428, "Precondition Required", {}, None)

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _http_428)
    ipmi_calls: list[list[str]] = []
    monkeypatch.setattr(
        bm_power.subprocess,
        "run",
        lambda argv, **kw: ipmi_calls.append(argv) or SimpleNamespace(returncode=0, stdout="", stderr=""),
    )
    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="on", timeout=30)
    assert state == "ipmi:on"
    assert any("bootdev" in a and "pxe" in a for a in ipmi_calls)
    assert any(a[-3:] == ["chassis", "power", "on"] for a in ipmi_calls)


def test_redfish_401_does_not_fall_back_on_patch(monkeypatch):
    monkeypatch.setattr(
        bm_power.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("IPMI must NOT run on 401")),
    )

    def _http_401(req, timeout=None, context=None):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _http_401)
    with pytest.raises(RedfishAuthError):
        bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="on", timeout=30)


def test_wrong_machine_guard_fires_before_transport(monkeypatch):
    redfish_called: list[bool] = []
    ipmi_called: list[bool] = []
    monkeypatch.setattr(bm_power.urllib.request, "urlopen", lambda *a, **k: redfish_called.append(True))
    monkeypatch.setattr(bm_power.subprocess, "run", lambda *a, **k: ipmi_called.append(True))
    with pytest.raises(BmPowerError, match="wrong-machine"):
        bm_power.boot_into_live(_node(), _CREDS, "00000000-0000-0000-0000-000000000000", action="on", timeout=30)
    assert redfish_called == []
    assert ipmi_called == []


def test_wait_ip_predicate_matches_hub_db_sql(monkeypatch):
    captured: dict[str, object] = {}

    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params):
            captured["sql"] = sql
            captured["params"] = params

        def fetchone(self):
            return ("192.168.200.20",)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def cursor(self):
            return _Cur()

    import psycopg

    monkeypatch.setattr(psycopg, "connect", lambda dsn: _Conn())
    ip = bm_power._wait_for_data_ip("postgresql://x", _PXE_MAC, timeout=1, interval=0)
    assert ip == "192.168.200.20"
    sql = captured["sql"]
    assert 'lower(ii."macAddress") = lower(%s)' in sql
    assert 'ii."deletedAt" IS NULL' in sql
    assert 'ip."deletedAt" IS NULL' in sql
    assert "ip.status = 'ACTIVE'" in sql
    assert "family(ip.address) = 4" in sql


def test_wait_ip_times_out_returns_none(monkeypatch):
    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params):
            pass

        def fetchone(self):
            return None

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def cursor(self):
            return _Cur()

    import psycopg

    monkeypatch.setattr(psycopg, "connect", lambda dsn: _Conn())
    monkeypatch.setattr(bm_power.time, "sleep", lambda _s: None)
    assert bm_power._wait_for_data_ip("postgresql://x", _PXE_MAC, timeout=0, interval=0) is None


def test_main_rejects_empty_expected_uuid(monkeypatch):
    touched: list[bool] = []
    monkeypatch.setattr(bm_power, "boot_into_live", lambda *a, **k: touched.append(True))
    monkeypatch.setattr(bm_power, "load_baremetal_nodes", lambda: [_node()])
    monkeypatch.setattr(bm_power, "load_bmc_creds", lambda _n: _CREDS)
    rc = bm_power.main([_PXE_MAC, "   ", "--boot-live"])
    assert rc == 2
    assert touched == []


def test_main_empty_uuid_message_mentions_sim_lc_device_id(monkeypatch):
    errors: list[str] = []
    monkeypatch.setattr(bm_power.log, "error", lambda m: errors.append(m))
    monkeypatch.setattr(bm_power, "load_baremetal_nodes", lambda: [_node()])
    assert bm_power.main([_PXE_MAC, "", "--boot-live"]) == 2
    assert any("SIM_LC_DEVICE_ID" in m for m in errors)


def test_auto_off_box_powers_on_redfish(monkeypatch):
    doc = {**_SYSTEM_DOC, "PowerState": "Off"}
    rec = _RedfishRecorder(system_doc=doc)
    _install_redfish(monkeypatch, rec)
    bm_power.boot_into_live(_node(system_id="1"), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    post = next(b for (m, _u, b) in rec.requests if m == "POST")
    assert post == {"ResetType": "On"}


def test_auto_on_box_resets_redfish(monkeypatch):
    doc = {**_SYSTEM_DOC, "PowerState": "On"}
    rec = _RedfishRecorder(system_doc=doc)
    _install_redfish(monkeypatch, rec)
    bm_power.boot_into_live(_node(system_id="1"), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    post = next(b for (m, _u, b) in rec.requests if m == "POST")
    assert post == {"ResetType": "ForceRestart"}


def _ipmi_fake(status_stdout: str):
    calls: list[list[str]] = []

    def _run(argv, capture_output=None, text=None, timeout=None, check=None):
        calls.append(argv)
        if argv[-3:] == ["chassis", "power", "status"]:
            return SimpleNamespace(returncode=0, stdout=status_stdout, stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return _run, calls


def _redfish_unreachable(monkeypatch):
    def _refused(req, timeout=None, context=None):
        raise urllib.error.URLError(ConnectionRefusedError("connection refused"))

    monkeypatch.setattr(bm_power.urllib.request, "urlopen", _refused)


def test_auto_off_box_powers_on_ipmi(monkeypatch):
    _redfish_unreachable(monkeypatch)
    run, calls = _ipmi_fake("Chassis Power is off")
    monkeypatch.setattr(bm_power.subprocess, "run", run)
    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    assert state == "ipmi:on"
    assert any(a[-3:] == ["chassis", "power", "on"] for a in calls)
    assert not any(a[-2:] == ["power", "reset"] for a in calls)


def test_auto_on_box_resets_ipmi(monkeypatch):
    _redfish_unreachable(monkeypatch)
    run, calls = _ipmi_fake("Chassis Power is on")
    monkeypatch.setattr(bm_power.subprocess, "run", run)
    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    assert state == "ipmi:reset"
    assert any(a[-2:] == ["power", "reset"] for a in calls)


def test_auto_ipmi_boot_source_before_power(monkeypatch):
    _redfish_unreachable(monkeypatch)
    run, calls = _ipmi_fake("Chassis Power is off")
    monkeypatch.setattr(bm_power.subprocess, "run", run)
    bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    bootdev_idx = next(i for i, a in enumerate(calls) if "bootdev" in a)
    power_idx = next(i for i, a in enumerate(calls) if a[-2:] == ["power", "on"])
    assert bootdev_idx < power_idx


def test_auto_ipmi_unreadable_status_degrades_to_on(monkeypatch):
    _redfish_unreachable(monkeypatch)

    def _run(argv, capture_output=None, text=None, timeout=None, check=None):
        if argv[-3:] == ["chassis", "power", "status"]:
            return SimpleNamespace(returncode=1, stdout="", stderr="unreadable")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(bm_power.subprocess, "run", _run)
    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    assert state == "ipmi:on"


def test_ipmitool_error_redacts_password_by_value(monkeypatch):
    def _run(argv, capture_output=None, text=None, timeout=None, check=None):
        return SimpleNamespace(returncode=1, stdout="", stderr=f"auth failed for {_CREDS.password}")

    monkeypatch.setattr(bm_power.subprocess, "run", _run)
    with pytest.raises(BmPowerError) as exc:
        bm_power.set_boot_pxe_ipmi(_node(), _CREDS, 30)
    assert _CREDS.password not in str(exc.value)
    assert "***" in str(exc.value)


def test_redact_argv_masks_password_regardless_of_position():
    argv = ["ipmitool", "-P", "s3cret", "chassis", "power", "on", "-N", "5"]
    out = bm_power._redact_argv(argv, "s3cret")
    assert "s3cret" not in out
    assert out.count("***") == 1


def test_systems_collection_resolved_once(monkeypatch):
    rec = _RedfishRecorder()
    _install_redfish(monkeypatch, rec)
    bm_power.boot_into_live(_node(system_id=None), _CREDS, _EXPECTED_UUID, action="on", timeout=30)
    systems_gets = [u for (m, u, _b) in rec.requests if m == "GET" and u.endswith("/redfish/v1/Systems")]
    assert len(systems_gets) == 1


def test_cli_positional_contract_node_then_uuid(monkeypatch):
    seen: dict[str, object] = {}

    def _capture(node, creds, expected_uuid, action="auto", *, timeout=60):
        seen["node_name"] = node.name
        seen["expected_uuid"] = expected_uuid
        seen["action"] = action
        return "On"

    monkeypatch.setattr(bm_power, "boot_into_live", _capture)
    monkeypatch.setattr(bm_power, "load_baremetal_nodes", lambda: [_node()])
    monkeypatch.setattr(bm_power, "load_bmc_creds", lambda _n: _CREDS)
    rc = bm_power.main([_PXE_MAC, _EXPECTED_UUID, "--boot-live"])
    assert rc == 0
    assert seen["expected_uuid"] == _EXPECTED_UUID
    assert seen["node_name"] == "bench-1"
    assert seen["action"] == "auto"


def test_run_ipmitool_timeout_raises_bmpowererror(monkeypatch):
    import subprocess

    def _timeout(*a, **k):
        raise subprocess.TimeoutExpired(cmd="ipmitool", timeout=60)

    monkeypatch.setattr(bm_power.subprocess, "run", _timeout)
    argv = [*bm_power._ipmitool_base(_node(), _CREDS), "chassis", "power", "on"]
    with pytest.raises(BmPowerError) as exc:
        bm_power._run_ipmitool(argv, _CREDS, 60)
    assert "timed out" in str(exc.value)
    assert _CREDS.password not in str(exc.value)
    assert exc.value.__cause__ is None
    assert exc.value.__suppress_context__ is True


def test_ipmi_power_status_timeout_returns_none(monkeypatch):
    import subprocess

    def _timeout(*a, **k):
        raise subprocess.TimeoutExpired(cmd="ipmitool", timeout=60)

    monkeypatch.setattr(bm_power.subprocess, "run", _timeout)
    assert bm_power.ipmi_power_status(_node(), _CREDS, 60) is None


def test_boot_source_readback_mismatch_falls_back_to_ipmi(monkeypatch):
    ignored = {**_SYSTEM_DOC, "Boot": {"BootSourceOverrideTarget": "None", "BootSourceOverrideEnabled": "Disabled"}}
    _install_redfish(monkeypatch, _RedfishRecorder(system_doc=ignored))
    run, calls = _ipmi_fake("Chassis Power is off")
    monkeypatch.setattr(bm_power.subprocess, "run", run)
    state = bm_power.boot_into_live(_node(), _CREDS, _EXPECTED_UUID, action="auto", timeout=30)
    assert state == "ipmi:on"
    assert any("bootdev" in a for a in calls)


def test_boot_source_readback_mismatch_names_ipmitool(monkeypatch):
    ignored = {**_SYSTEM_DOC, "Boot": {"BootSourceOverrideTarget": "None", "BootSourceOverrideEnabled": "Disabled"}}
    _install_redfish(monkeypatch, _RedfishRecorder(system_doc=ignored))
    auth = bm_power._auth_header(_CREDS)
    with pytest.raises(_RedfishUnusable) as exc:
        bm_power.set_boot_pxe_redfish("https://198.51.100.250", auth, "/redfish/v1/Systems/1", 30)
    assert "accepted but ignored" in str(exc.value)
    assert "chassis bootdev pxe options=persistent,efiboot" in str(exc.value)


def test_ipmi_boot_source_options_match_bridge_saga(monkeypatch):
    run, calls = _ipmi_fake("Chassis Power is off")
    monkeypatch.setattr(bm_power.subprocess, "run", run)
    bm_power.set_boot_pxe_ipmi(_node(), _CREDS, 30)
    argv = next(a for a in calls if "bootdev" in a)
    assert argv[-3:] == ["bootdev", "pxe", "options=persistent,efiboot"]


def test_status_issues_no_mutating_verb_and_returns_power_state(monkeypatch):
    rec = _RedfishRecorder()
    _install_redfish(monkeypatch, rec)
    ipmi_called: list[bool] = []
    monkeypatch.setattr(bm_power.subprocess, "run", lambda *a, **k: ipmi_called.append(True))
    state = bm_power.bm_status(_node(), _CREDS, _EXPECTED_UUID, timeout=30)
    assert state == "On"
    assert [m for (m, _u, _b) in rec.requests] == ["GET", "GET"]
    assert ipmi_called == []


def test_status_keeps_wrong_machine_guard(monkeypatch):
    rec = _RedfishRecorder()
    _install_redfish(monkeypatch, rec)
    with pytest.raises(BmPowerError) as exc:
        bm_power.bm_status(_node(), _CREDS, "00000000-0000-0000-0000-000000000000", timeout=30)
    assert "wrong-machine" in str(exc.value)
    assert rec.requests == []


def test_status_unreachable_redfish_is_bmpowererror(monkeypatch):
    _redfish_unreachable(monkeypatch)
    with pytest.raises(BmPowerError) as exc:
        bm_power.bm_status(_node(), _CREDS, _EXPECTED_UUID, timeout=30)
    assert "status read failed" in str(exc.value)


def test_cli_status_never_reaches_boot_into_live(monkeypatch):
    booted: list[bool] = []
    monkeypatch.setattr(bm_power, "boot_into_live", lambda *a, **k: booted.append(True))
    monkeypatch.setattr(bm_power, "load_baremetal_nodes", lambda: [_node()])
    monkeypatch.setattr(bm_power, "load_bmc_creds", lambda _n: _CREDS)
    monkeypatch.setattr(bm_power, "bm_status", lambda *a, **k: "Off")
    printed: list[str] = []
    monkeypatch.setattr(bm_power.log, "info", lambda m: printed.append(m))
    rc = bm_power.main([_PXE_MAC, _EXPECTED_UUID, "--status"])
    assert rc == 0
    assert booted == []
    assert any("PowerState=Off" in m for m in printed)


def test_cli_commission_error_is_named_not_a_traceback(monkeypatch):
    from local.commission_baremetal import CommissionError

    def _boom() -> list[BareMetalNode]:
        raise CommissionError("no bare-metal nodes in fleet.yaml")

    monkeypatch.setattr(bm_power, "load_baremetal_nodes", _boom)
    errors: list[str] = []
    monkeypatch.setattr(bm_power.log, "error", lambda m: errors.append(m))
    assert bm_power.main([_PXE_MAC, _EXPECTED_UUID, "--status"]) == 1
    assert errors == ["no bare-metal nodes in fleet.yaml"]
