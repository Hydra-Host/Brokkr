from __future__ import annotations

import json
import subprocess
from pathlib import Path

from local import show_env
from local.show_env import (
    Knob,
    build_tree,
    model_json,
    overlay_summary,
    parse_model,
    render_value,
)
from rich.console import Console

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "config-model.json"

_BLIND_SPOTS = ("lan.expose", "telemetry.enable", "stack.slot", "fleet.mode", "fleet.autoStart")


def _model() -> dict:
    return json.loads(_FIXTURE.read_text())


def _knobs(model: dict | None = None) -> dict[str, Knob]:
    return {knob.path: knob for knob in parse_model(model if model is not None else _model())}


def _set_value(model: dict, path: str, value: object) -> None:
    for entry in model["values"]:
        if entry["path"] == path:
            entry["value"] = value
            return
    raise AssertionError(f"{path} not in the captured values")


def _override_option(model: dict, path: str, value: object, file: str = "stack.local.nix") -> dict:
    _set_value(model, path, value)
    for entry in model["provenance"]:
        if entry["path"] == path:
            entry["files"] = [file]
            return model
    raise AssertionError(f"{path} not in the captured provenance")


def _override_env(model: dict, path: str, value: object, file: str = "stack.local.nix") -> dict:
    target = next(c["overrideFrom"] for c in model["catalog"] if c["path"] == path)
    _set_value(model, path, value)
    for entry in model["provenance"]:
        if entry["path"] == target:
            entry["files"] = [file]
            entry["perKey"][path.rsplit(".", 1)[-1]] = [file]
            return model
    raise AssertionError(f"{target} not in the captured provenance")


def test_fixture_is_a_whole_config_model_capture() -> None:
    model = _model()
    assert model["catalog"] and model["values"] and model["provenance"]
    assert {c["path"] for c in model["catalog"]} == {v["path"] for v in model["values"]}
    assert all(c["description"] and c["label"] and c["kind"] for c in model["catalog"])


def test_former_blind_spots_are_in_the_model() -> None:
    knobs = _knobs()
    assert set(_BLIND_SPOTS) <= set(knobs)
    assert knobs["fleet.mode"].choices == ("vm", "baremetal")
    assert knobs["stack.slot"].editable is False


def test_sections_come_from_the_catalog_group() -> None:
    knobs = _knobs()
    assert knobs["ports.postgres"].group == "Datastores"
    assert knobs["lan.expose"].group == "Networking"
    labels = [str(child.label) for child in build_tree(list(knobs.values()), show_secrets=False).children]
    assert labels == sorted({knob.group for knob in knobs.values()})


def test_clean_capture_has_no_overrides() -> None:
    knobs = _knobs()
    assert not [knob.path for knob in knobs.values() if knob.overridden]
    assert knobs["ports.postgres"].sources == ("devenv/modules/overrides.nix",)
    assert knobs["stackDefaults.hub.LOG_LEVEL"].sources == ("devenv/modules/hub.nix",)


def test_clean_capture_summary_says_no_overrides() -> None:
    out = "\n".join(overlay_summary(list(_knobs().values())))
    assert "no local overrides" in out
    assert "run `task config`" in out


def test_present_overlay_that_defines_nothing_is_not_an_override() -> None:
    out = "\n".join(overlay_summary(list(_knobs().values()), present=("devenv.local.nix",)))
    assert "overlay files: devenv.local.nix" in out
    assert "no local overrides — all defaults" in out
    assert "overridden leaf(s)" not in out


def test_option_knob_override_is_attributed_to_its_overlay() -> None:
    knobs = _knobs(_override_option(_model(), "ports.postgres", 5433))
    assert knobs["ports.postgres"].value == 5433
    assert knobs["ports.postgres"].sources == ("stack.local.nix",)
    assert knobs["ports.postgres"].overridden is True


def test_env_knob_override_is_attributed_through_override_from() -> None:
    model = _override_env(_model(), "stackDefaults.hub.LOG_LEVEL", "warn")
    knobs = _knobs(model)
    assert knobs["stackDefaults.hub.LOG_LEVEL"].value == "warn"
    assert knobs["stackDefaults.hub.LOG_LEVEL"].sources == ("stack.local.nix",)
    assert knobs["stackDefaults.spoke.LOG_LEVEL"].overridden is False


def test_devenv_local_nix_override_is_named_as_the_source() -> None:
    knobs = _knobs(_override_option(_model(), "fleet.autoStart", False, file="devenv.local.nix"))
    assert knobs["fleet.autoStart"].sources == ("devenv.local.nix",)
    assert knobs["fleet.autoStart"].overridden is True


def test_secret_flagged_knob_is_masked_by_default() -> None:
    password = _knobs()["identity.pg.password"]
    assert password.secret is True
    assert render_value(password, show_secrets=False) == "***"
    assert render_value(password, show_secrets=True) == "password"


def test_non_secret_knob_is_never_masked() -> None:
    user = _knobs()["identity.pg.user"]
    assert user.secret is False
    assert render_value(user, show_secrets=False) == "brokkr"


def test_dsn_userinfo_is_masked_on_shape() -> None:
    dsn = _knobs()["stackDefaults.hub.DATABASE_URL"]
    assert dsn.secret is False
    assert render_value(dsn, show_secrets=False) == "postgresql://***@127.0.0.1:5432/brokkr"
    assert "brokkr:password@" in render_value(dsn, show_secrets=True)


def test_unset_knob_renders_as_unset() -> None:
    assert render_value(_knobs()["stackDefaults.hub.HUB_REPO_PATH"], show_secrets=False) == "(unset)"


def test_bool_knob_renders_lowercase() -> None:
    assert render_value(_knobs()["fleet.autoStart"], show_secrets=False) == "true"
    assert render_value(_knobs()["lan.expose"], show_secrets=False) == "false"


def test_json_round_trips_and_masks_secrets() -> None:
    knobs = list(_knobs().values())
    payload = json.loads(json.dumps(model_json(knobs, show_secrets=False)))
    assert len(payload) == len(knobs)
    assert [e["path"] for e in payload] == sorted(e["path"] for e in payload)
    by_path = {e["path"]: e for e in payload}
    assert by_path["identity.pg.password"]["value"] == "***"
    assert by_path["identity.pg.password"]["default"] == "***"
    assert by_path["ports.postgres"]["value"] == 5432
    assert by_path["fleet.mode"]["choices"] == ["vm", "baremetal"]
    assert by_path["lan.expose"]["sources"] == ["devenv/modules/overrides.nix"]


def test_json_reveals_secrets_under_show_secrets() -> None:
    payload = {e["path"]: e for e in model_json(list(_knobs().values()), show_secrets=True)}
    assert payload["identity.pg.password"]["value"] == "password"
    assert payload["stackDefaults.hub.DATABASE_URL"]["value"].startswith("postgresql://brokkr:password@")


def test_summary_counts_overridden_leaves_per_overlay_file() -> None:
    model = _override_option(_model(), "ports.postgres", 5433)
    _override_option(model, "stackCounts.spoke", 2)
    _override_option(model, "lan.expose", True, file="devenv.local.nix")
    _override_env(model, "stackDefaults.spoke.TELEGRAF_ENABLED", "false")
    out = "\n".join(overlay_summary(list(_knobs(model).values()), present=("stack.local.nix",)))
    assert "stack.local.nix: 3 overridden leaf(s)" in out
    assert "devenv.local.nix: 1 overridden leaf(s)" in out
    assert "overlay files: stack.local.nix" in out


def test_summary_names_every_overridden_knob() -> None:
    model = _override_option(_model(), "ports.postgres", 5433)
    _override_env(model, "stackDefaults.hub.LOG_LEVEL", "warn")
    out = "\n".join(overlay_summary(list(_knobs(model).values())))
    assert "ports.postgres=5433" in out
    assert "stackDefaults.hub.LOG_LEVEL=warn" in out


def test_summary_elides_a_long_override_list() -> None:
    model = _model()
    paths = [c["path"] for c in model["catalog"] if c["overrideFrom"] is None][:12]
    for path in paths:
        _override_option(model, path, "x")
    out = "\n".join(overlay_summary(list(_knobs(model).values())))
    named = next(ln for ln in out.splitlines() if ln.strip().startswith("overridden:"))
    assert named.count("\u00b7") == 8
    assert "+4 more" in named


def test_summary_masks_an_overridden_secret() -> None:
    knobs = _knobs(_override_option(_model(), "identity.pg.password", "hunter2"))
    out = "\n".join(overlay_summary(list(knobs.values())))
    assert "identity.pg.password=***" in out
    assert "hunter2" not in out


def test_summary_digest_reports_the_former_blind_spots() -> None:
    out = "\n".join(overlay_summary(list(_knobs().values())))
    assert "slot=0" in out
    assert "hub=1 · spoke=1" in out
    assert "fleet.autoStart=true" in out
    assert "fleet.mode=vm" in out
    assert "lan.expose=false" in out
    assert "telemetry=false" in out
    assert "pg=brokkr/brokkr" in out


def _rendered(knobs, show_secrets: bool = False) -> str:
    console = Console(width=400)
    with console.capture() as capture:
        console.print(build_tree(list(knobs), show_secrets=show_secrets))
    return capture.get()


def test_tree_marks_a_read_only_knob() -> None:
    line = next(ln for ln in _rendered(_knobs().values()).splitlines() if "stack.slot" in ln)
    assert "(read-only)" in line
    assert "[devenv/modules/overrides.nix]" in line


def test_tree_marks_a_danger_knob() -> None:
    line = next(ln for ln in _rendered(_knobs().values()).splitlines() if "lan.expose" in ln)
    assert "(danger)" in line


def test_tree_names_the_overlay_for_an_overridden_knob() -> None:
    knobs = _knobs(_override_option(_model(), "ports.redis", 6380))
    line = next(ln for ln in _rendered(knobs.values()).splitlines() if "ports.redis" in ln)
    assert "6380" in line
    assert "[stack.local.nix]" in line


def test_tree_masks_secrets_unless_revealed() -> None:
    assert "identity.pg.password: ***" in _rendered(_knobs().values())
    assert "identity.pg.password: password" in _rendered(_knobs().values(), show_secrets=True)


def test_tree_reports_an_undefined_knob_source() -> None:
    line = next(ln for ln in _rendered(_knobs().values()).splitlines() if "HUB_REPO_PATH" in ln)
    assert "(unset)" in line
    assert "(no definition)" in line


def test_devenv_eval_asks_for_one_attr_and_supplies_a_secretspec_reason(monkeypatch, tmp_path) -> None:
    seen: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["env"] = kwargs["env"]
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"configModel": _model()}), "")

    monkeypatch.delenv("SECRETSPEC_REASON", raising=False)
    monkeypatch.setattr(show_env.subprocess, "run", fake_run)
    model = show_env._devenv_eval(tmp_path)

    assert seen["cmd"] == ["devenv", "eval", "configModel"]
    assert seen["env"]["SECRETSPEC_REASON"]
    assert len(model["catalog"]) == len(_model()["catalog"])


def test_devenv_eval_keeps_a_caller_supplied_reason(monkeypatch, tmp_path) -> None:
    seen: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        seen["env"] = kwargs["env"]
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"configModel": _model()}), "")

    monkeypatch.setenv("SECRETSPEC_REASON", "caller reason")
    monkeypatch.setattr(show_env.subprocess, "run", fake_run)
    show_env._devenv_eval(tmp_path)

    assert seen["env"]["SECRETSPEC_REASON"] == "caller reason"


def test_devenv_eval_rejects_a_payload_without_the_attr(monkeypatch, tmp_path) -> None:
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"ports": {}}), "")

    monkeypatch.setattr(show_env.subprocess, "run", fake_run)
    try:
        show_env._devenv_eval(tmp_path)
    except RuntimeError as exc:
        assert "configModel" in str(exc)
    else:
        raise AssertionError("expected a RuntimeError")


def test_present_overlays_reports_only_existing_files(tmp_path) -> None:
    assert show_env._present_overlays(tmp_path) == ()
    (tmp_path / "stack.local.nix").write_text("{ }\n")
    assert show_env._present_overlays(tmp_path) == ("stack.local.nix",)


def test_overlay_restated_at_its_default_is_not_overridden():
    """The control center rewrites identity/osLayerCache verbatim on every save, so real Nix
    provenance attributes them to stack.local.nix while their values still equal the defaults."""
    model = _model()
    for entry in model["provenance"]:
        if entry["path"] == "identity.pg.user":
            entry["files"] = ["stack.local.nix"]
            break
    else:
        model["provenance"].append({"path": "identity.pg.user", "files": ["stack.local.nix"], "perKey": {}})
    knob = _knobs(model)["identity.pg.user"]
    assert "stack.local.nix" in knob.sources
    assert knob.value == knob.default
    assert not knob.overridden


def test_overlay_with_a_differing_value_is_overridden():
    model = _model()
    for entry in model["values"]:
        if entry["path"] == "identity.pg.user":
            entry["value"] = "someone-else"
            break
    for entry in model["provenance"]:
        if entry["path"] == "identity.pg.user":
            entry["files"] = ["stack.local.nix"]
            break
    else:
        model["provenance"].append({"path": "identity.pg.user", "files": ["stack.local.nix"], "perKey": {}})
    knob = _knobs(model)["identity.pg.user"]
    assert knob.overridden
