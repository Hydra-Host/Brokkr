#!/usr/bin/env bash
# Generator-driven sim seed (run by the sim:seed devenv task). Run sql-seed/*.py generators →
# _generated/*.sql, then apply the GENERATED SQL in numeric order. The static notify triggers
# (sql-seed/20-*.sql) are owned by the pre-hub sql-seed:notify task — re-applying them here too
# would fire a second, concurrent CREATE OR REPLACE FUNCTION and race that task on pg_proc.
# Waits for the Hub org bootstrap first.
set -euo pipefail
shopt -s nullglob
cd "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)" # sim/ — sql-seed/* globs are sim-relative
DSN="${HUB_DATABASE_URL:-postgresql://brokkr:password@127.0.0.1:5432/brokkr}"
# The sim org is created by the Hub admin app's better-auth bootstrap
# (the hub's main.admin.ts: SIM_ORG_ID = 00000000-…-000000000000, which writes
# the Organization + better-auth Member + Owner user). The seed only
# FK-references that org, never creates it. So wait on the SAME id the
# generators emit — sim.hydrahost_org_id / SIM_HYDRAHOST_ORG_ID — instead of a
# separate ORG_ID knob that could pass the wait while the generated SQL points
# at a different org. It's effectively fixed at all-zeros: changing it means
# changing the Hub bootstrap too, not just this env.
ORG_ID="${SIM_HYDRAHOST_ORG_ID:-00000000-0000-0000-0000-000000000000}"
GEN=sql-seed/_generated
mkdir -p "$GEN"

# 1. Wait for Hub admin bootstrap to create the org the data seed FK-references.
echo "→ waiting for Organization $ORG_ID (Hub admin bootstrap)…"
ok=
for _ in $(seq 1 80); do
  if psql "$DSN" -tAc "SELECT 1 FROM \"Organization\" WHERE id='$ORG_ID'" 2>/dev/null | grep -q 1; then
    ok=1
    break
  fi
  sleep 3
done
[ -n "$ok" ] || {
  echo "✗ org $ORG_ID not found after 240s — is the Hub API (:3000) up?" >&2
  exit 1
}

# 2. Generate: each NN-name.py emits SQL to stdout → _generated/NN-name.sql.
for gen in $(ls sql-seed/[0-9]*.py 2>/dev/null | sort); do
  base=$(basename "$gen" .py)
  echo "  gen → $GEN/$base.sql"
  # Write to a temp file then atomically rename. $GEN is shared across every seed invoker
  # (the devenv sim:seed task + the control center's seed / fleet-rebuild ops); a plain
  # `python > file` truncates the live file in place, so an overlapping run's `psql -f`
  # could read it mid-stream and fail with "syntax error at end of input". rename never
  # truncates the live inode, so a concurrent reader always sees a complete file (old or
  # new) — both are idempotent. Also leaves the prior file intact if a generator crashes.
  tmp="$GEN/.$base.sql.tmp.$$"
  python "$gen" >"$tmp"
  mv -f "$tmp" "$GEN/$base.sql"
done

# 3. Apply the generated SQL in numeric order. The static sql-seed/*.sql (the notify triggers)
#    is applied separately — pre-hub — by the sql-seed:notify task; applying it here too would
#    run a second concurrent CREATE OR REPLACE FUNCTION and race on pg_proc.
for f in $(ls "$GEN"/*.sql 2>/dev/null | sort); do
  echo "  apply → $f"
  psql "$DSN" -v ON_ERROR_STOP=1 -q -f "$f" || exit 1
done
echo "✓ sql-seed:run complete"
