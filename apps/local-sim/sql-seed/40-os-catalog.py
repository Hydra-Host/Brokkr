#!/usr/bin/env python
"""Generator: OS catalog manifest → idempotent ``LayerGroup``/``Layer``/``LayerArtifact`` SQL.

Fetches the manifest host, degrading to the system layers alone when it is unreachable; FKs resolve
at apply-time via slug subqueries."""

from __future__ import annotations

from typing import Any

from local.logger import log
from local.seed.os_catalog import normalize_kind, normalize_selection_type, try_fetch_manifest
from local.sqlemit import header, logs_to_stderr, q


def _ts(value) -> str:
    return f"{q(value)}::timestamp" if value is not None else "NULL"


def generate() -> str:
    manifest = try_fetch_manifest()
    groups: list[dict[str, Any]] = []
    layers: list[dict[str, Any]] = []
    version = "offline"
    if manifest is not None:
        # Boss does not import legacy OS bundles — drop the legacy group + kind=legacy entries.
        all_groups = manifest.get("groups") or []
        groups = [g for g in all_groups if (g.get("slug") or "").lower() != "legacy"]
        all_layers = manifest.get("layers") or []
        layers = [e for e in all_layers if (e.get("kind") or "").lower() != "legacy"]
        version = manifest.get("version", "?")
        dropped_groups = len(all_groups) - len(groups)
        dropped_layers = len(all_layers) - len(layers)
        log.info(
            f"OS manifest version={version!r} groups={len(groups)} layers={len(layers)} "
            f"(dropped {dropped_layers} legacy layers, {dropped_groups} legacy groups)"
        )

    out = [header("40-os-catalog.py"), "BEGIN;\n\n"]
    if manifest is None:
        out.append("-- manifest host unreachable: system layers only, no OS bases/artifacts.\n\n")

    # --- Seed LayerBuild (local-sim always uses a deterministic build row) ---
    seed_build_id = "local-sim-seed"
    out.append("-- LayerBuild (seed)\n")
    out.append(
        f"""INSERT INTO "LayerBuild"
    (id, version, env, "schemaVersion", "manifestUrl", status, "importedAt", "updatedAt")
VALUES ({q(seed_build_id)}, {q(version)}, 'dev', 7, 'local-sim', 'READY'::"LayerBuildStatus", NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    version = EXCLUDED.version, env = EXCLUDED.env,
    "schemaVersion" = EXCLUDED."schemaVersion", "manifestUrl" = EXCLUDED."manifestUrl",
    status = EXCLUDED.status, "updatedAt" = NOW();

INSERT INTO "PlatformSettings" (id, "defaultLayerBuildId", "updatedAt")
VALUES ('singleton', {q(seed_build_id)}, NOW())
ON CONFLICT (id) DO UPDATE SET "defaultLayerBuildId" = EXCLUDED."defaultLayerBuildId", "updatedAt" = NOW();
"""
    )

    # --- LayerGroup (by slug) ---
    out.append("-- LayerGroup\n")
    for g in groups:
        slug = g["slug"]
        sel = normalize_selection_type(g.get("selection_type"))
        out.append(
            f"""INSERT INTO "LayerGroup" (id, slug, name, "selectionType", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), {q(slug)}, {q(g.get("name", slug))}, {q(sel)}::"LayerSelectionType", NOW(), NOW())
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, "selectionType" = EXCLUDED."selectionType", "updatedAt" = NOW();
"""
        )
    group_slugs = {g["slug"] for g in groups}

    # --- Layer (one per unique slug; FK group via slug subquery) ---
    out.append("\n-- Layer\n")
    by_slug = {entry["name"]: entry for entry in layers}
    emitted_layers: set[str] = set()
    for slug, entry in by_slug.items():
        group_slug = entry["group"]
        if group_slug not in group_slugs:
            log.warn(f"layer {slug!r} references unknown group {group_slug!r} — skipping")
            out.append(f"-- skipped layer {slug}: unknown group {group_slug}\n")
            continue
        kind = normalize_kind(entry["kind"])
        out.append(
            f"""INSERT INTO "Layer" (id, slug, name, family, kind, "layerGroupId", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), {q(slug)}, {q(entry["display_name"])},
    {q(entry.get("family"))}, {q(kind)}::"LayerKind",
    (SELECT id FROM "LayerGroup" WHERE slug = {q(group_slug)}), NOW(), NOW())
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, family = EXCLUDED.family,
    kind = EXCLUDED.kind, "layerGroupId" = EXCLUDED."layerGroupId", "updatedAt" = NOW();
"""
        )
        emitted_layers.add(slug)

    # LIVE rows are system images (rescue/discovery), kept out of the customer base dropdown by
    # kind=LIVE; ipxe-custom is BASE with no LayerArtifact (the bridge chainloads a user-supplied URL).
    out.append("\n-- System layers (live + custom-iPXE)\n")
    out.append(
        """INSERT INTO "LayerGroup" (id, slug, name, "selectionType", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'liveOS', 'Live & System Images', 'SINGLE_SELECT'::"LayerSelectionType", NOW(), NOW())
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, "selectionType" = EXCLUDED."selectionType", "updatedAt" = NOW();
"""
    )
    out.append(
        """INSERT INTO "LayerGroup" (id, slug, name, "selectionType", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'baseOS', 'Base OS Images', 'SINGLE_SELECT'::"LayerSelectionType", NOW(), NOW())
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, "selectionType" = EXCLUDED."selectionType", "updatedAt" = NOW();
"""
    )
    _system_layers = [
        ("ubuntu-rescue-os", "Ubuntu Rescue OS", "LIVE", "live", "liveOS"),
        ("brokkr-discovery", "Brokkr Live (discovery)", "LIVE", "live", "liveOS"),
        ("ipxe-custom", "iPXE Custom", "BASE", "base", "baseOS"),
    ]
    for slug, name, kind, family, group_slug in _system_layers:
        group_expr = f"""(SELECT id FROM "LayerGroup" WHERE slug = {q(group_slug)})"""
        out.append(
            f"""INSERT INTO "Layer" (id, slug, name, family, kind, "layerGroupId", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), {q(slug)}, {q(name)}, {q(family)}, {q(kind)}::"LayerKind",
    {group_expr}, NOW(), NOW())
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, family = EXCLUDED.family, kind = EXCLUDED.kind,
    "layerGroupId" = EXCLUDED."layerGroupId", "updatedAt" = NOW();
"""
        )

    # --- LayerArtifact (one per entry; upsert by (layerBuildId, sha256)) ---
    out.append("\n-- LayerArtifact\n")
    for e in layers:
        if e["name"] not in emitted_layers:
            continue
        lid = f'(SELECT id FROM "Layer" WHERE slug = {q(e["name"])})'
        variant = e.get("variant") or ""
        out.append(
            f"""INSERT INTO "LayerArtifact" (
    id, "layerId", "layerBuildId", "osDistro", "osCodename", "osVersion", arch, variant,
    sha256, url, size, compression, kernel, "releaseVersion", "sourceVersion", filename,
    "builtAt", "builtByPipelineId", "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid(), {lid}, {q(seed_build_id)}, {q(e["os_distro"])}, {q(e["os_codename"])}, {q(e["os_version"])},
    {q(e["arch"])}, {q(variant)},
    {q(e["sha256"])}, {q(e["url"])}, {int(e["size"])}, {q(e.get("compression") or "zstd")},
    {q(e.get("kernel"))}, {q(e.get("release_version"))}, {q(e.get("source_version"))}, {q(e.get("filename"))},
    {_ts(e.get("built_at"))}, {int(e["built_by_pipeline_id"]) if e.get("built_by_pipeline_id") is not None else "NULL"},
    NOW(), NOW()
)
ON CONFLICT ("layerBuildId", "layerId", "osDistro", "osCodename", arch, variant) DO UPDATE SET
    sha256 = EXCLUDED.sha256, "osVersion" = EXCLUDED."osVersion",
    url = EXCLUDED.url, size = EXCLUDED.size,
    compression = EXCLUDED.compression, kernel = EXCLUDED.kernel,
    "releaseVersion" = EXCLUDED."releaseVersion", "sourceVersion" = EXCLUDED."sourceVersion",
    filename = EXCLUDED.filename, "builtAt" = EXCLUDED."builtAt",
    "builtByPipelineId" = EXCLUDED."builtByPipelineId", "updatedAt" = NOW();
"""
        )

    out.append("\nCOMMIT;\n")
    return "".join(out)


if __name__ == "__main__":
    logs_to_stderr()
    print(generate(), end="")
