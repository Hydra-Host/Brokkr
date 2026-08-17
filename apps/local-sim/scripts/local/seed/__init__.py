"""Sim seed shapers — the pure shapers the ``sql-seed/`` generators import.

Static netplan, storage layouts, SSH fingerprinting, and the OS-layers manifest fetch/normalizers.
"""

from __future__ import annotations

from local.seed.netplan import sim_static_netplan
from local.seed.os_catalog import fetch_manifest, http_get_json, normalize_kind, normalize_selection_type
from local.seed.ssh_keys import iter_ssh_pubkeys, ssh_fingerprint
from local.seed.storage import build_storage_layouts

__all__ = [
    "build_storage_layouts",
    "fetch_manifest",
    "http_get_json",
    "iter_ssh_pubkeys",
    "normalize_kind",
    "normalize_selection_type",
    "sim_static_netplan",
    "ssh_fingerprint",
]
