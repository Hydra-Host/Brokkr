from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console
from rich.text import Text
from rich.tree import Tree

from local.logger import log
from local.masking import mask_dsn

# overlay files (gitignored) that can carry local config, in the order devenv imports them.
_OVERLAY_FILES = ("stack.local.nix", "devenv.local.nix")

_EVAL_REASON = "inspect the resolved local-dev config"
_MASK = "***"
_UNSET = "(unset)"
_UNSOURCED = "(no definition)"
# the block stays one screenful even when the control center has written a large overlay.
_NAME_CAP = 8

# the compact block names these outright; every other knob appears only when it is overridden.
_DIGEST = (
    ("slot", "stack.slot"),
    ("hub", "stackCounts.hub"),
    ("spoke", "stackCounts.spoke"),
    ("fleet.autoStart", "fleet.autoStart"),
    ("lan.mode", "lan.mode"),
    ("lan.datastoreAuth", "lan.datastoreAuth"),
    ("telemetry", "telemetry.enable"),
)


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


@dataclass(frozen=True)
class Knob:
    """One catalog entry joined to its effective value and the files that define it."""

    path: str
    label: str
    group: str
    description: str
    kind: str
    value: object
    default: object
    choices: tuple[str, ...]
    editable: bool
    danger: bool
    secret: bool
    sources: tuple[str, ...]

    @property
    def overridden(self) -> bool:
        """An overlay FILE in the provenance is not enough. The control center restates identity
        and osLayerCache verbatim on every save, so those leaves are attributed to stack.local.nix
        while still equal to their defaults; only a differing value is an override."""
        return self.value != self.default and any(f in _OVERLAY_FILES for f in self.sources)


def _sources(entry: dict, provenance: dict[str, dict]) -> tuple[str, ...]:
    """Files responsible for a knob's effective value. An env knob's override lands in the attrs
    option named by `overrideFrom`, whose per-key attribution therefore outranks the module that
    only supplies the default."""
    target = entry.get("overrideFrom")
    if target:
        per_key = provenance.get(target, {}).get("perKey") or {}
        for key in (entry["path"].rsplit(".", 1)[-1], *(entry.get("alias") or ())):
            if per_key.get(key):
                return tuple(per_key[key])
    return tuple(provenance.get(entry["path"], {}).get("files") or ())


def parse_model(model: dict) -> list[Knob]:
    """Knobs from a `devenv eval configModel` payload. Its three parts are LISTS keyed by `path`,
    not attrsets — `devenv eval` cannot serialize an attrset whose keys contain dots."""
    values = {e["path"]: e.get("value") for e in model.get("values") or ()}
    provenance = {e["path"]: e for e in model.get("provenance") or ()}
    return [
        Knob(
            path=entry["path"],
            label=entry.get("label") or entry["path"],
            group=entry.get("group") or "Other",
            description=entry.get("description") or "",
            kind=entry.get("kind") or "text",
            value=values.get(entry["path"]),
            default=entry.get("default"),
            choices=tuple(entry.get("choices") or ()),
            editable=bool(entry.get("editable", True)),
            danger=bool(entry.get("danger", False)),
            secret=bool(entry.get("secret", False)),
            sources=_sources(entry, provenance),
        )
        for entry in model.get("catalog") or ()
    ]


def _mask(value: object, *, secret: bool, show_secrets: bool) -> object:
    """A DSN is masked on shape as well as on the flag — its userinfo carries a credential the
    catalog marks on the knob that seeds it, not on the URL that embeds it."""
    if show_secrets or value is None:
        return value
    if secret:
        return _MASK
    if isinstance(value, str) and "://" in value and "@" in value:
        return mask_dsn(value)
    return value


def render_value(knob: Knob, show_secrets: bool) -> str:
    value = _mask(knob.value, secret=knob.secret, show_secrets=show_secrets)
    if value is None:
        return _UNSET
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def model_json(knobs: Sequence[Knob], show_secrets: bool) -> list[dict]:
    return [
        {
            "path": knob.path,
            "label": knob.label,
            "group": knob.group,
            "description": knob.description,
            "kind": knob.kind,
            "value": _mask(knob.value, secret=knob.secret, show_secrets=show_secrets),
            "default": _mask(knob.default, secret=knob.secret, show_secrets=show_secrets),
            "choices": list(knob.choices),
            "editable": knob.editable,
            "danger": knob.danger,
            "secret": knob.secret,
            "sources": list(knob.sources),
            "overridden": knob.overridden,
        }
        for knob in sorted(knobs, key=lambda k: k.path)
    ]


def overlay_summary(knobs: Sequence[Knob], present: Sequence[str] = ()) -> list[str]:
    """Compact "local overrides applied" block for `task status`."""
    by_path = {knob.path: knob for knob in knobs}

    def shown(path: str) -> str:
        knob = by_path.get(path)
        return render_value(knob, show_secrets=False) if knob else "?"

    overridden = sorted((k for k in knobs if k.overridden), key=lambda k: k.path)
    lines = ["local config:"]
    if present:
        lines.append("  overlay files: " + ", ".join(present))
    # a present overlay that defines no knob is not an override — only provenance can tell them apart.
    if not overridden:
        lines.append("  no local overrides — all defaults")
    else:
        counts = Counter(f for knob in overridden for f in knob.sources if f in _OVERLAY_FILES)
        for fname in _OVERLAY_FILES:
            if counts[fname]:
                lines.append(f"  {fname}: {counts[fname]} overridden leaf(s)")
        named = " · ".join(f"{k.path}={shown(k.path)}" for k in overridden[:_NAME_CAP])
        elided = len(overridden) - _NAME_CAP
        lines.append(f"  overridden: {named}" + (f" · +{elided} more" if elided > 0 else ""))

    lines.append("  " + " · ".join(f"{name}={shown(path)}" for name, path in _DIGEST))
    lines.append(
        f"  pg={shown('identity.pg.user')}/{shown('identity.pg.db')}"
        f" · orgId={shown('identity.orgId')}"
        f" · osLayer={shown('osLayerCache.originHost')}"
    )
    lines.append("  → run `task config` for the full source-tagged tree")
    return lines


def _label(knob: Knob, show_secrets: bool) -> Text:
    label = Text(f"{knob.path}: ")
    label.append(render_value(knob, show_secrets), style="bold" if knob.overridden else "")
    label.append(f"  [{', '.join(knob.sources) or _UNSOURCED}]", style="dim")
    if not knob.editable:
        label.append(" (read-only)", style="dim")
    if knob.danger:
        label.append(" (danger)", style="yellow")
    return label


def build_tree(knobs: Sequence[Knob], show_secrets: bool) -> Tree:
    root = Tree(Text("environment config", style="bold cyan"))
    for group in sorted({knob.group for knob in knobs}):
        branch = root.add(Text(group, style="cyan"))
        for knob in sorted((k for k in knobs if k.group == group), key=lambda k: k.path):
            branch.add(_label(knob, show_secrets))
    return root


def _devenv_eval(root: Path) -> dict:
    env = {**os.environ}
    env.setdefault("SECRETSPEC_REASON", _EVAL_REASON)
    proc = subprocess.run(
        ["devenv", "eval", "configModel"],
        cwd=root,
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "devenv eval failed")
    payload = json.loads(proc.stdout)  # stdout only — devenv writes cache-miss noise to stderr
    if "configModel" not in payload:
        raise RuntimeError("devenv eval returned no configModel attr")
    return payload["configModel"]


def _present_overlays(root: Path) -> tuple[str, ...]:
    return tuple(fname for fname in _OVERLAY_FILES if (root / fname).exists())


def _drift_line() -> str | None:
    """Fleet applied-vs-declared drift, appended to the summary. Best-effort: a missing or
    unparseable fleet.yml must not break a config read."""
    try:
        import yaml

        from local import applied
        from local.config import get_settings
        from local.host_os import host_os
        from local.schema import Fleet

        src = os.environ.get("LOCAL_FLEET_SOURCE")
        fleet_path = Path(src) if src else get_settings().paths.fleet_path
        if not fleet_path.exists():
            return None
        fleet = Fleet.model_validate(yaml.safe_load(fleet_path.read_text()))
        return applied.drift_summary_line(applied.diff(fleet, applied.read(), host_os()))
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m local.show_env",
        description="Resolved devenv config knobs and the files that define them, as a Rich tree or JSON.",
    )
    parser.add_argument("--summary", action="store_true", help="Compact overrides block for `task status`.")
    parser.add_argument("--json", action="store_true", help="Emit the whole config model as JSON.")
    parser.add_argument("--show-secrets", action="store_true", help="Unmask secrets (default: masked).")
    args = parser.parse_args()

    root = _devenv_root()
    try:
        knobs = parse_model(_devenv_eval(root))
    except Exception as exc:  # surface any eval failure as one operator-facing line
        log.error(f"devenv eval failed: {exc}")
        log.detail("Are you in the devenv shell at the repo root? (DEVENV_ROOT set)")
        return 1

    if args.json:
        print(json.dumps(model_json(knobs, show_secrets=args.show_secrets), indent=2))
        return 0

    if args.summary:
        lines = overlay_summary(knobs, _present_overlays(root))
        drift = _drift_line()
        if drift:
            lines.append(drift)
        for line in lines:
            print(line)
        return 0

    Console().print(build_tree(knobs, show_secrets=args.show_secrets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
