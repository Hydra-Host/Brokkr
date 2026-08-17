#!/usr/bin/env bash
# devenv sql-seed:notify task — load the static brok-local SQL
# bootstrap scripts (sql-seed/*.sql, lexical order) into the hub DB via native
# psql (devenv-native postgres; no container). The generator-driven seed lives
# in sql-seed-run.sh.
set -euo pipefail
shopt -s nullglob
cd "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)" # sim/ — sql-seed/* globs are sim-relative
DSN="${HUB_DATABASE_URL:-postgresql://brokkr:password@127.0.0.1:5432/brokkr}"
for f in $(ls sql-seed/*.sql 2>/dev/null | sort); do
  echo "  → $f"
  psql "$DSN" -v ON_ERROR_STOP=1 -q -f "$f" || exit 1
done
