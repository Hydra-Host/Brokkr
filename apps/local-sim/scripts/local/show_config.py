from __future__ import annotations

import argparse
import sys

from pydantic import ValidationError
from rich.console import Console
from rich.text import Text
from rich.tree import Tree

from local.config import Settings, get_settings
from local.logger import log
from local.masking import mask_dsn

_SUBMODEL_ORDER = ("state", "paths", "bridge", "sim", "stores", "runtime")

_SECRET_FIELDS = frozenset({"hub_database_url", "bridge_redis_url"})


def _format_value(name: str, value: object, show_secrets: bool) -> str:
    if value is None:
        return "(unset)"
    if not show_secrets and name in _SECRET_FIELDS and isinstance(value, str):
        return mask_dsn(value)
    return str(value)


def _label(name: str, value: object, source: str, show_secrets: bool) -> Text:
    label = Text(f"{name}: ")
    label.append(_format_value(name, value, show_secrets), style="bold" if source == "env" else "")
    label.append(f"  [{source}]", style="dim")
    return label


def _build_tree(settings: Settings, show_secrets: bool) -> Tree:
    root = Tree(Text("local config", style="bold cyan"))
    for sub_name in _SUBMODEL_ORDER:
        submodel = getattr(settings, sub_name)
        branch = root.add(Text(sub_name, style="cyan"))
        klass = type(submodel)
        fields_set = submodel.model_fields_set
        for fname in klass.model_fields:
            value = getattr(submodel, fname)
            source = "env" if fname in fields_set else "default"
            branch.add(_label(fname, value, source, show_secrets))
        for cname in klass.model_computed_fields:
            value = getattr(submodel, cname)
            branch.add(_label(cname, value, "computed", show_secrets))
    return root


def _report_validation_error(exc: ValidationError) -> None:
    for err in exc.errors():
        loc = ".".join(str(x) for x in err["loc"]) or "<root>"
        log.error(f"settings.{loc}: {err['msg']}")
    log.detail("Check your .env file or shell exports — see .env.example for the required keys.")


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m local.show_config",
        description="Print the resolved local settings as a Rich tree.",
    )
    parser.add_argument(
        "--show-secrets",
        action="store_true",
        help="Show passwords in DSN values (default: masked).",
    )
    args = parser.parse_args()

    try:
        settings = get_settings()
    except ValidationError as exc:
        _report_validation_error(exc)
        return 1

    Console().print(_build_tree(settings, show_secrets=args.show_secrets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
