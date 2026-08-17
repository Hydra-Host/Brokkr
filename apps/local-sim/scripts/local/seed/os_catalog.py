"""OS-layers manifest fetch + enum normalizers for the ``40-os-catalog`` SQL generator (the pure
fetch/parse half — the write side lives in the generated SQL)."""

from __future__ import annotations

import urllib.request
from typing import Any

import yaml

from local.config import get_settings
from local.logger import log

# Cloudflare in front of the asset host 403s the default Python-urllib UA.
_USER_AGENT = "local-environment-seed/1.0"


def http_get_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return yaml.safe_load(resp.read())
    except Exception as exc:
        raise RuntimeError(f"failed to fetch {url}: {exc}") from exc


def fetch_manifest() -> dict[str, Any]:
    """Resolve the configured index URL to a manifest dict.

    Accepts a release *index* (``{"url": ...}`` → followed) or a versioned *manifest*
    (``{"layers": [...]}``) directly.
    """
    index_url = get_settings().sim.os_layers_manifest_index_url
    log.info(f"resolve OS-layers manifest from {index_url}")
    doc = http_get_json(index_url)
    if "layers" in doc:
        return doc
    manifest_url = doc.get("url")
    if not manifest_url:
        raise RuntimeError(f"{index_url} is neither a manifest ('layers') nor an index ('url'): {doc!r}")
    log.info(f"fetch manifest {manifest_url}")
    return http_get_json(manifest_url)


def try_fetch_manifest() -> dict[str, Any] | None:
    """:func:`fetch_manifest`, or ``None`` when the asset origin cannot be reached.

    The asset origin is the sim's only external dependency; a hard failure here would take the
    whole ``task up`` DAG down, so the caller degrades to the rows that need no manifest.
    """
    try:
        return fetch_manifest()
    except Exception as exc:
        log.warn(f"OS-layers manifest unavailable — {exc}")
        log.warn(
            "seeding system layers only (rescue, brokkr-discovery, custom-iPXE): the sim will have "
            "NO selectable OS bases, so provisioning a customer OS fails until this is fixed. Point "
            "SIM_OS_LAYERS_MANIFEST_INDEX_URL (devenv: the osLayerCache.originHost knob) at a "
            "reachable manifest, then re-run `devenv tasks run sim:seed`."
        )
        return None


def normalize_selection_type(s: str | None) -> str:
    """Pass through ``SINGLE_SELECT`` / ``MULTI_SELECT``; default the rest
    (legacy groups) to ``SINGLE_SELECT``."""
    return s if s in ("SINGLE_SELECT", "MULTI_SELECT") else "SINGLE_SELECT"


def normalize_kind(k: str) -> str:
    """Map manifest lowercase ``base|component|legacy`` to the uppercase
    Prisma enum ``BASE|COMPONENT|LEGACY|INTERNAL``."""
    m = {"base": "BASE", "component": "COMPONENT", "legacy": "LEGACY", "internal": "INTERNAL"}
    return m.get(k.lower(), k.upper())
