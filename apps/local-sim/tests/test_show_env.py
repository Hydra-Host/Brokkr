from __future__ import annotations

from local.show_env import (
    _EVAL_ATTRS,
    Leaf,
    Section,
    _render_leaf_value,
    build_model,
    overlay_summary,
)

_DEFAULT_EVAL = {
    "stackOverrides": {"hub": {}, "spoke": {}},
    "stackCounts": {"hub": 1, "spoke": 1},
    "identity": {
        "pg": {"user": "brokkr", "password": "password", "db": "brokkr"},
        "orgId": "00000000-0000-0000-0000-000000000000",
    },
    "osLayerCache": {"originHost": "brokkr.assets.hydra.host", "resolvers": "1.1.1.1 8.8.8.8"},
    "ports": {"redis": 6379, "postgres": 5432, "hubApi": {"base": 3000, "step": 2}},
    "fleet": {
        "autoStart": True,
        "network": {"name": "brokkr-net"},
        "defaults": {"cpus": 2, "bmc": {"username": "admin", "password": "admin"}},
        "nodes": {"cpu-1": {"index": 1, "enable": True, "ipmi_mac": "52:54:00:bc:00:01"}},
    },
    "env.HUB_REPO_PATH": "/home/x/brokkr-app",
    "env.LOCAL_FLEET_PATH": "/nix/store/abc-fleet.yml",
}


def _flatten(sections: list[Section]) -> dict[str, Leaf]:
    out: dict[str, Leaf] = {}

    def walk(prefix: str, sec: Section) -> None:
        path = f"{prefix}/{sec.title}" if prefix else sec.title
        for leaf in sec.leaves:
            out[f"{path}/{leaf.name}"] = leaf
        for child in sec.children:
            walk(path, child)

    for sec in sections:
        walk("", sec)
    return out


def test_eval_attrs_have_no_dead_spoke_repo_path() -> None:
    assert "env.SPOKE_REPO_PATH" not in _EVAL_ATTRS


def test_clean_tree_all_default() -> None:
    sections = build_model(_DEFAULT_EVAL, overlays={}, env_text="")
    leaves = _flatten(sections)
    assert all(leaf.source == "default" for leaf in leaves.values()), {
        k: v.source for k, v in leaves.items() if v.source != "default"
    }


def test_clean_tree_summary_says_no_overrides() -> None:
    sections = build_model(_DEFAULT_EVAL, overlays={}, env_text="")
    out = "\n".join(overlay_summary(sections, overlays={}))
    assert "no local overrides" in out
    assert "run `task config`" in out


def test_stack_override_tagged_to_stack_local() -> None:
    ev = {**_DEFAULT_EVAL, "stackOverrides": {"hub": {"LOG_LEVEL": "info"}, "spoke": {}}}
    overlays = {"stack.local.nix": 'stackOverrides.hub = {\n    "LOG_LEVEL" = "info";\n  };\n'}
    sections = build_model(ev, overlays, env_text="")
    leaf = _flatten(sections)["Stack overrides/hub/LOG_LEVEL"]
    assert leaf.value == "info"
    assert leaf.source == "overlay:stack.local.nix"


def test_count_override_detected() -> None:
    ev = {**_DEFAULT_EVAL, "stackCounts": {"hub": 1, "spoke": 2}}
    overlays = {"stack.local.nix": "stackCounts.spoke = 2;\n"}
    sections = build_model(ev, overlays, env_text="")
    leaves = _flatten(sections)
    assert leaves["Stack overrides/spoke/count"].source == "overlay:stack.local.nix"
    assert leaves["Stack overrides/hub/count"].source == "default"


def test_identity_value_change_is_override_even_when_file_restates_default() -> None:
    ev = {
        **_DEFAULT_EVAL,
        "identity": {
            "pg": {"user": "alice", "password": "password", "db": "brokkr"},
            "orgId": _DEFAULT_EVAL["identity"]["orgId"],
        },
    }
    overlays = {
        "stack.local.nix": (
            'identity.pg.user = "alice";\n'
            'identity.pg.password = "password";\n'
            'identity.pg.db = "brokkr";\n'
            'identity.orgId = "00000000-0000-0000-0000-000000000000";\n'
        )
    }
    sections = build_model(ev, overlays, env_text="")
    leaves = _flatten(sections)
    assert leaves["Service identity/pg.user"].source == "overlay:stack.local.nix"
    assert leaves["Service identity/pg.db"].source == "default"
    assert leaves["Service identity/orgId"].source == "default"


def test_password_masked_unless_revealed() -> None:
    secret = Leaf("pg.password", "hunter2", "overlay:stack.local.nix", secret=True)
    assert _render_leaf_value(secret, show_secrets=False) == "***"
    assert _render_leaf_value(secret, show_secrets=True) == "hunter2"


def test_oslayer_override_from_devenv_local() -> None:
    ev = {**_DEFAULT_EVAL, "osLayerCache": {"originHost": "my.cache", "resolvers": "1.1.1.1 8.8.8.8"}}
    overlays = {"devenv.local.nix": 'osLayerCache.originHost = "my.cache";\n'}
    sections = build_model(ev, overlays, env_text="")
    leaf = _flatten(sections)["OS-layer cache/originHost"]
    assert leaf.source == "overlay:devenv.local.nix"


def test_fleet_autostart_override_and_node_control_fields() -> None:
    ev = {**_DEFAULT_EVAL, "fleet": {**_DEFAULT_EVAL["fleet"], "autoStart": False}}
    overlays = {"devenv.local.nix": "fleet.autoStart = false;\n"}
    sections = build_model(ev, overlays, env_text="")
    leaves = _flatten(sections)
    assert leaves["Fleet/autoStart"].source == "overlay:devenv.local.nix"
    assert "Fleet/nodes (1)/cpu-1/index (control)" in leaves
    assert leaves["Fleet/nodes (1)/cpu-1/index (control)"].source == "default"


def test_repo_path_from_dotenv() -> None:
    sections = build_model(_DEFAULT_EVAL, overlays={}, env_text="HUB_REPO_PATH=/home/x/brokkr-app\n")
    leaf = _flatten(sections)["Repo paths/HUB_REPO_PATH"]
    assert leaf.source == ".env"


def test_repo_path_attributed_to_polyrepo_overlay() -> None:
    hub_ovl = {"devenv.local.nix": 'polyrepo.hub.path = "/srv/brokkr-app";\n'}
    leaves = _flatten(build_model(_DEFAULT_EVAL, hub_ovl, env_text=""))
    assert leaves["Repo paths/HUB_REPO_PATH"].source == "overlay:devenv.local.nix"


def test_bmc_password_masked_in_defaults() -> None:
    sections = build_model(_DEFAULT_EVAL, overlays={}, env_text="")
    leaf = _flatten(sections)["Fleet/defaults/bmc/password"]
    assert leaf.secret is True
    assert _render_leaf_value(leaf, show_secrets=False) == "***"


def test_summary_reports_override_counts() -> None:
    ev = {
        **_DEFAULT_EVAL,
        "stackOverrides": {"hub": {"LOG_LEVEL": "info"}, "spoke": {}},
        "stackCounts": {"hub": 1, "spoke": 2},
    }
    overlays = {"stack.local.nix": 'stackOverrides.hub = { "LOG_LEVEL" = "info"; };\nstackCounts.spoke = 2;\n'}
    sections = build_model(ev, overlays, env_text="")
    out = "\n".join(overlay_summary(sections, overlays))
    assert "stack.local.nix" in out
    assert "overridden leaf(s)" in out
    assert "spoke=2" in out
