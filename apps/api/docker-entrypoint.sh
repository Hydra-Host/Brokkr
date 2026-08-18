#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Runtime env-config.js generator
# ---------------------------------------------------------------------------
# Instead of baking VITE_* variables at Docker build time (which creates one
# image per environment), this script writes a tiny JS file that exposes
# public, browser-safe config on window.__ENV__ at **container start**.
# The SPA's index.html loads /env-config.js before the app bundle, so the
# values are available synchronously.
# ---------------------------------------------------------------------------

CONFIG_PATH="/app/apps/web/dist/env-config.js"

cat >"$CONFIG_PATH" <<EOF
// Auto-generated at container start — do not edit.
window.__ENV__ = Object.freeze({
  RADAR_PUBLISHABLE_KEY: "${RADAR_PUBLISHABLE_KEY:-}",
  DOCS_URL: "${BROKKR_DOCS_URL:-}"
});
EOF

echo "wrote runtime env-config.js → $CONFIG_PATH"

# ---------------------------------------------------------------------------
# Database migrations
# ---------------------------------------------------------------------------
# Apply pending migrations on every start (default). `prisma migrate deploy` is
# idempotent — it records applied migrations in `_prisma_migrations` and runs only
# pending ones (a no-op when the DB is current), serialized by a Postgres advisory
# lock so concurrent boots are safe. This is the self-hosted norm: `docker compose
# up` (or pull-new-image + restart) keeps the schema current with zero extra steps.
# `set -e` makes a failed migration abort the container, so a broken upgrade stops
# loudly instead of serving against a half-migrated DB.
#
# The managed (multi-replica) edition sets RUN_DB_MIGRATIONS=false and applies
# migrations via a gated pipeline job, so the app's runtime DB role needs no DDL.
if [ "${RUN_DB_MIGRATIONS:-true}" != "false" ]; then
  echo "applying database migrations (prisma migrate deploy)…"
  # prisma bin is hoisted to the root node_modules by pnpm; run from the database
  # package dir so prisma discovers prisma.config.ts (schema folder + datasource).
  if ! (cd /app/packages/database && /app/node_modules/.bin/prisma migrate deploy); then
    echo "database migration failed — aborting startup" >&2
    exit 1
  fi
  echo "database schema is up to date"
fi

# ---------------------------------------------------------------------------
# OS layer catalog seed
# ---------------------------------------------------------------------------
# Provisioning (and the commission→qualify flow) deploys an OS drawn from the layer
# catalog; an unseeded catalog makes qualify-provision fail with "Operating
# system <os> not found for qualify deployment". Seed it from the release
# manifest on start so a fresh deployment can provision without a manual step.
#
# Idempotent by design: a manifest version maps to one immutable LayerBuild, so a
# second run of the same version is a benign "Cannot re-import" no-op (handled
# below). Non-fatal — a transient asset-host outage must not stop the hub from
# serving; the next restart retries. Override the source (or set empty to
# disable) via OS_LAYER_MANIFEST_URL.
#
# The default is the release *index* — a `{version,url}` pointer, not a manifest — so that a fresh
# deployment seeds the current catalog instead of whatever version was hardcoded here. The seed
# script parses a manifest, so follow the pointer one hop; a versioned manifest URL is passed
# through verbatim, and an unreachable/odd document falls through to the seed's own error path.
# The hop is bounded at 8s: a black-holed origin would otherwise block startup forever (a refused
# connection does not), and 8s is generous against a ~300ms round trip plus a cold DNS+TLS setup.
OS_LAYER_MANIFEST_URL="${OS_LAYER_MANIFEST_URL-https://brokkr.assets.hydra.host/os-layers/releases/latest}"
if [ -n "$OS_LAYER_MANIFEST_URL" ]; then
  resolved_manifest_url=$(node -e '
const src = process.argv[1];
fetch(src, { signal: AbortSignal.timeout(8000) })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => process.stdout.write(d && !d.layers && typeof d.url === "string" ? d.url : src))
  .catch(() => process.stdout.write(src));
' "$OS_LAYER_MANIFEST_URL" 2>/dev/null) || resolved_manifest_url=""
  if [ -n "$resolved_manifest_url" ]; then
    OS_LAYER_MANIFEST_URL="$resolved_manifest_url"
  fi
  # braces are load-bearing: sh reads the trailing "…" bytes as part of the variable name
  echo "seeding OS layer catalog from ${OS_LAYER_MANIFEST_URL}…"
  if seed_out=$(node dist/scripts/layers/seed-from-manifest.js --url="$OS_LAYER_MANIFEST_URL" --seed-script 2>&1); then
    echo "OS layer catalog seeded"
  elif printf '%s' "$seed_out" | grep -q "Cannot re-import"; then
    echo "OS layer catalog already current for this manifest version — skipping"
  else
    echo "OS layer catalog seed FAILED (non-fatal; any previously seeded catalog remains available):" >&2
    printf '%s\n' "$seed_out" | tail -8 >&2
  fi
fi

# Hand off to the main process.
exec node dist/main "$@"
