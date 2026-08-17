from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from rich.console import Console
from rich.text import Text
from rich.tree import Tree

from local.logger import log
from local.masking import mask_dsn

# All config attrs come from one `devenv eval` call — ports/paths are config attrs, so no
# separate `nix eval -f modules/ports.nix` is needed.
_EVAL_ATTRS = (
    "stackOverrides",
    "stackCounts",
    "identity",
    "osLayerCache",
    "ports",
    "fleet",
    "env.HUB_REPO_PATH",
    "env.LOCAL_FLEET_PATH",
)

# A leaf is "overridden" when its resolved value differs from these defaults — the control
# center always restates identity/osLayerCache, so file-presence alone would over-report.
_IDENTITY_DEFAULTS = {
    "pg.user": "brokkr",
    "pg.password": "password",
    "pg.db": "brokkr",
    "orgId": "00000000-0000-0000-0000-000000000000",
}
_OSLAYER_DEFAULTS = {
    "originHost": "brokkr.assets.hydra.host",
    "resolvers": "1.1.1.1 8.8.8.8",
}
_FLEET_AUTOSTART_DEFAULT = True

# overlay files (gitignored) that can carry local config, in the order devenv imports them.
_OVERLAY_FILES = ("stack.local.nix", "devenv.local.nix")

# Nix-only control fields on a fleet node — stripped before the rendered fleet.yml.
_FLEET_CONTROL_FIELDS = frozenset({"index", "enable"})

_DEFAULT = "default"
_DOTENV = ".env"


def _devenv_root() -> Path:
    """Repo root (where devenv.nix + the overlay files live). DEVENV_ROOT is set inside the
    devenv shell; otherwise walk up to the nearest devenv.nix."""
    env = os.environ.get("DEVENV_ROOT")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        if (parent / "devenv.nix").exists():
            return parent
    return Path.cwd()


def _is_secret(path: str) -> bool:
    return path.endswith("password") or path.endswith(".pg.password")


@dataclass
class Leaf:
    name: str
    value: object
    source: str  # _DEFAULT | _DOTENV | "overlay:<file>"
    secret: bool = False


@dataclass
class Section:
    title: str
    leaves: list[Leaf] = field(default_factory=list)
    children: list[Section] = field(default_factory=list)


def _overlay_for(dotted: str, overlays: dict[str, str]) -> str | None:
    """Which overlay file textually sets a dotted attr path (e.g. ``identity.pg.user``)."""
    tokens = dotted.split(".")
    literal = re.compile(re.escape(dotted) + r"\s*=")
    loose = re.compile(r"\b" + r"\b[\s.={]*".join(re.escape(t) for t in tokens) + r"\b")
    for fname in _OVERLAY_FILES:
        text = overlays.get(fname)
        if text and (literal.search(text) or loose.search(text)):
            return fname
    return None


def _src(dotted: str, overlays: dict[str, str], *, overridden: bool) -> str:
    """Source tag for a leaf: the overlay file that set it (when overridden), else default."""
    if not overridden:
        return _DEFAULT
    return f"overlay:{_overlay_for(dotted, overlays) or _OVERLAY_FILES[0]}"


def _fmt_scalar(v: object) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _port_leaf(name: str, value: object, overlays: dict[str, str]) -> Leaf:
    overridden = _overlay_for(f"ports.{name}", overlays) is not None
    if isinstance(value, dict):
        rendered = " ".join(f"{k}={_fmt_scalar(v)}" for k, v in sorted(value.items()))
    else:
        rendered = _fmt_scalar(value)
    return Leaf(name, rendered, _src(f"ports.{name}", overlays, overridden=overridden))


def build_model(
    ev: dict,
    overlays: dict[str, str],
    env_text: str = "",
) -> list[Section]:
    """Assemble the source-tagged config model from a `devenv eval` result, the overlay-file
    texts (filename → contents), and the repo-root .env contents. Pure: no I/O, fully testable."""
    sections: list[Section] = []

    ports = ev.get("ports") or {}
    sections.append(Section("Ports & routes", [_port_leaf(k, ports[k], overlays) for k in sorted(ports)]))

    repo = Section("Repo paths")
    # Monorepo: hub + bridge + agent share the one HUB_REPO_PATH checkout (no separate spoke path).
    env_key = "HUB_REPO_PATH"
    val = ev.get(f"env.{env_key}")
    if re.search(rf"^\s*{re.escape(env_key)}\s*=", env_text, re.MULTILINE):
        source = _DOTENV
    else:
        ovl = _overlay_for(f"env.{env_key}", overlays) or _overlay_for("polyrepo.hub.path", overlays)
        source = f"overlay:{ovl}" if ovl else _DEFAULT
    repo.leaves.append(Leaf(env_key, val, source))
    sections.append(repo)

    identity = ev.get("identity") or {}
    id_sec = Section("Service identity")
    for dotted, default in _IDENTITY_DEFAULTS.items():
        cur = identity
        for part in dotted.split("."):
            cur = cur.get(part, {}) if isinstance(cur, dict) else None
        value = cur if not isinstance(cur, dict) else None
        overridden = value is not None and str(value) != default
        id_sec.leaves.append(
            Leaf(
                dotted,
                value,
                _src(f"identity.{dotted}", overlays, overridden=overridden),
                secret=_is_secret(f"identity.{dotted}"),
            )
        )
    sections.append(id_sec)

    osl = ev.get("osLayerCache") or {}
    osl_sec = Section("OS-layer cache")
    for key, default in _OSLAYER_DEFAULTS.items():
        value = osl.get(key)
        overridden = value is not None and str(value) != default
        osl_sec.leaves.append(Leaf(key, value, _src(f"osLayerCache.{key}", overlays, overridden=overridden)))
    sections.append(osl_sec)

    so = ev.get("stackOverrides") or {}
    counts = ev.get("stackCounts") or {}
    overrides_sec = Section("Stack overrides")
    for group in ("hub", "spoke"):
        knobs = so.get(group) or {}
        grp = Section(group)
        for key in sorted(knobs):
            grp.leaves.append(
                Leaf(
                    key,
                    knobs[key],
                    f"overlay:{_overlay_for(f'stackOverrides.{group}.{key}', overlays) or _OVERLAY_FILES[0]}",
                    secret=_is_secret(key.lower()),
                )
            )
        count = counts.get(group, 1)
        grp.leaves.append(Leaf("count", count, _src(f"stackCounts.{group}", overlays, overridden=int(count) != 1)))
        overrides_sec.children.append(grp)
    sections.append(overrides_sec)

    sections.append(_fleet_section(ev.get("fleet") or {}, ev.get("env.LOCAL_FLEET_PATH"), overlays))
    return sections


def _fleet_section(fleet: dict, fleet_path: object, overlays: dict[str, str]) -> Section:
    sec = Section("Fleet")
    autostart = fleet.get("autoStart", _FLEET_AUTOSTART_DEFAULT)
    sec.leaves.append(
        Leaf(
            "autoStart",
            autostart,
            _src("fleet.autoStart", overlays, overridden=bool(autostart) != _FLEET_AUTOSTART_DEFAULT),
        )
    )
    if fleet_path is not None:
        sec.leaves.append(Leaf("rendered", fleet_path, _DEFAULT))

    fleet_overlay = _overlay_for("fleet.nodes", overlays) or _overlay_for("fleet.defaults", overlays)
    topo_src = f"overlay:{fleet_overlay}" if fleet_overlay else _DEFAULT

    net = fleet.get("network") or {}
    if net:
        sec.children.append(Section("network", [Leaf(k, net[k], topo_src) for k in sorted(net)]))

    defaults = fleet.get("defaults") or {}
    if defaults:
        dsec = Section("defaults")
        for k in sorted(defaults):
            v = defaults[k]
            if isinstance(v, dict):
                dsec.children.append(
                    Section(
                        k,
                        [Leaf(ik, v[ik], topo_src, secret=_is_secret(f"{k}.{ik}")) for ik in sorted(v)],
                    )
                )
            else:
                dsec.leaves.append(Leaf(k, v, topo_src))
        sec.children.append(dsec)

    nodes = fleet.get("nodes") or {}
    if nodes:
        nsec = Section(f"nodes ({len(nodes)})")
        for name in sorted(nodes):
            spec = nodes[name] or {}
            node = Section(name)
            for fk in sorted(spec):
                control = fk in _FLEET_CONTROL_FIELDS
                node.leaves.append(
                    Leaf(
                        f"{fk} (control)" if control else fk,
                        spec[fk],
                        _DEFAULT if control else topo_src,
                        secret=_is_secret(fk.lower()),
                    )
                )
            nsec.children.append(node)
        sec.children.append(nsec)
    return sec


def overlay_summary(sections: list[Section], overlays: dict[str, str]) -> list[str]:
    """Compact "local overrides applied" block for `task status`."""
    present = [f for f in _OVERLAY_FILES if overlays.get(f)]
    overridden: dict[str, int] = {}

    def walk(sec: Section) -> None:
        for leaf in sec.leaves:
            if leaf.source.startswith("overlay:"):
                overridden[leaf.source.split(":", 1)[1]] = overridden.get(leaf.source.split(":", 1)[1], 0) + 1
        for child in sec.children:
            walk(child)

    for sec in sections:
        walk(sec)

    lines = ["local config:"]
    if not present and not overridden:
        lines.append("  no local overrides — all defaults")
    else:
        if present:
            lines.append("  overlay files: " + ", ".join(present))
        for fname in _OVERLAY_FILES:
            if overridden.get(fname):
                lines.append(f"  {fname}: {overridden[fname]} overridden leaf(s)")

    def find(title: str, sub: str | None = None) -> Section | None:
        for sec in sections:
            if sec.title == title:
                if sub is None:
                    return sec
                for child in sec.children:
                    if child.title == sub:
                        return child
        return None

    def leaf_val(sec: Section | None, name: str) -> str:
        if sec:
            for leaf in sec.leaves:
                if leaf.name == name:
                    return _render_leaf_value(leaf, show_secrets=False)
        return "?"

    repo = find("Repo paths")
    ident = find("Service identity")
    osl = find("OS-layer cache")
    fleet = find("Fleet")
    hub = find("Stack overrides", "hub")
    spoke = find("Stack overrides", "spoke")
    fleet_nodes = next((c for c in (fleet.children if fleet else []) if c.title.startswith("nodes")), None)
    lines.append(
        "  "
        + " · ".join(
            [
                f"hub={leaf_val(hub, 'count')}",
                f"spoke={leaf_val(spoke, 'count')}",
                f"fleet.autoStart={leaf_val(fleet, 'autoStart')}",
                f"orgId={leaf_val(ident, 'orgId')}",
                f"pg={leaf_val(ident, 'pg.user')}/{leaf_val(ident, 'pg.db')}",
                f"osLayer={leaf_val(osl, 'originHost')}",
                f"fleetNodes={len(fleet_nodes.children) if fleet_nodes else 0}",
            ]
        )
    )
    lines.append(f"  hub repo: {leaf_val(repo, 'HUB_REPO_PATH')}")
    lines.append("  → run `task config` for the full source-tagged tree")
    return lines


def _render_leaf_value(leaf: Leaf, show_secrets: bool) -> str:
    if leaf.value is None:
        return "(unset)"
    if leaf.secret and not show_secrets:
        return "***"
    if isinstance(leaf.value, bool):
        return "true" if leaf.value else "false"
    text = str(leaf.value)
    if not show_secrets and isinstance(leaf.value, str) and "://" in text and "@" in text:
        return mask_dsn(text)
    return text


def _label(leaf: Leaf, show_secrets: bool) -> Text:
    label = Text(f"{leaf.name}: ")
    label.append(_render_leaf_value(leaf, show_secrets), style="bold" if leaf.source != _DEFAULT else "")
    label.append(f"  [{leaf.source}]", style="dim")
    return label


def _add_section(parent: Tree, sec: Section, show_secrets: bool) -> None:
    branch = parent.add(Text(sec.title, style="cyan"))
    for leaf in sec.leaves:
        branch.add(_label(leaf, show_secrets))
    for child in sec.children:
        _add_section(branch, child, show_secrets)


def build_tree(sections: list[Section], show_secrets: bool) -> Tree:
    root = Tree(Text("environment config", style="bold cyan"))
    for sec in sections:
        _add_section(root, sec, show_secrets)
    return root


def _devenv_eval(root: Path) -> dict:
    proc = subprocess.run(
        ["devenv", "eval", *_EVAL_ATTRS],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "devenv eval failed")
    return json.loads(proc.stdout)  # stdout only — devenv writes cache-miss noise to stderr


def _read_overlays(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for fname in _OVERLAY_FILES:
        path = root / fname
        if path.exists():
            out[fname] = path.read_text()
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m local.show_env",
        description="Resolved devenv environment config + local overlay provenance, as a Rich tree.",
    )
    parser.add_argument("--summary", action="store_true", help="Compact overrides block for `task status`.")
    parser.add_argument("--show-secrets", action="store_true", help="Unmask passwords (default: masked).")
    args = parser.parse_args()

    root = _devenv_root()
    try:
        ev = _devenv_eval(root)
    except Exception as exc:  # surface any eval failure as one operator-facing line
        log.error(f"devenv eval failed: {exc}")
        log.detail("Are you in the devenv shell at the repo root? (DEVENV_ROOT set)")
        return 1

    overlays = _read_overlays(root)
    env_text = (root / ".env").read_text() if (root / ".env").exists() else ""
    sections = build_model(ev, overlays, env_text)

    if args.summary:
        lines = overlay_summary(sections, overlays)
        try:
            import yaml

            from local import applied
            from local.config import get_settings
            from local.host_os import host_os
            from local.schema import Fleet

            src = os.environ.get("LOCAL_FLEET_SOURCE")
            fleet_path = Path(src) if src else get_settings().paths.fleet_path
            if fleet_path.exists():
                f = Fleet.model_validate(yaml.safe_load(fleet_path.read_text()))
                lines.append(applied.drift_summary_line(applied.diff(f, applied.read(), host_os())))
        except Exception:  # best-effort drift line — a fleet/read/parse failure must not break the summary
            pass
        for line in lines:
            print(line)
        return 0

    Console().print(build_tree(sections, show_secrets=args.show_secrets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
