#!/usr/bin/env bash
# Reconcile the supervised process-compose processes to their intended running state — the
# single source of truth for stack self-heal, shared by `task up` (RECONCILE_INCLUDE_CC=1) and
# the control center's "Reconcile" op (which streams this output). Assumes the process-compose
# server is already up; it does NOT cold-start it (that stays `devenv up -d`'s job).
#
# Heals only the long-running supervised services — datastores, hub, spoke, observability, and
# (opt-in) the control center. Never the fleet, fleet plumbing (virtqemud), or the one-shot
# init tasks (migrate / sim:seed / fleet:init): those are matched by neither tier below.
# Leaves Disabled processes (opt-in-off) and
# already-Running ones untouched.
set -u

# Resolve the pc UDS the same way the control center's client does: PC_SOCKET_PATH wins, else
# $DEVENV_RUNTIME/pc.sock. No silent default — an unresolved socket means we're not in the env.
PC_SOCK="${PC_SOCKET_PATH:-${DEVENV_RUNTIME:-}/pc.sock}"
if [ -z "${PC_SOCKET_PATH:-}" ] && [ -z "${DEVENV_RUNTIME:-}" ]; then
  echo "✗ stack-reconcile: no process-compose socket (set PC_SOCKET_PATH, or run inside the devenv shell)" >&2
  exit 2
fi

pc() { process-compose -U -u "$PC_SOCK" "$@"; }

if ! pc process list -o json >/dev/null 2>&1; then
  echo "✗ stack-reconcile: process-compose server unreachable at $PC_SOCK — is the stack up? (task up / devenv up -d)" >&2
  exit 2
fi

INCLUDE_CC="${RECONCILE_INCLUDE_CC:-0}"
# control-plane (default): datastores + hub + spoke. datastores: just the datastore
# tier (the dashboard's "Datastores up" op). CC is added on top of either via RECONCILE_INCLUDE_CC.
SCOPE="${RECONCILE_SCOPE:-control-plane}"
failed=()
SNAP="[]"

refresh() { SNAP="$(pc process list -o json 2>/dev/null || echo '[]')"; }

# A field of one process out of the cached snapshot (empty string when absent).
jqf() { printf '%s' "$SNAP" | jq -r --arg n "$1" "(.[]|select(.name==\$n)|$2)//\"\""; }
pstatus() { jqf "$1" '.status'; }
pready() { jqf "$1" '.is_ready'; }

# Process names in the current snapshot belonging to a process-compose namespace, in snapshot order.
# Tiers are keyed on the declared namespace (datastore|hub|spoke|control), not a name allowlist,
# so a process added to devenv with an existing namespace is reconciled with no edit here.
match_ns() { printf '%s' "$SNAP" | jq -r --arg ns "$1" '.[]|select(.namespace==$ns)|.name'; }

# Running and not failing its readiness probe. Lenient on is_ready: a probe-less datastore
# reports "-"/"" yet is usable when Running — only an explicit "Not Ready" keeps us waiting.
is_up() {
  local s r
  s="$(pstatus "$1")"
  r="$(pready "$1")"
  [ "$s" = "Running" ] && [ "$r" != "Not Ready" ]
}

# A status that means the process has stopped and won't come back on its own — gave up
# (process-compose stops restarting at max_restarts → Completed), crashed terminally, or was
# stopped. These are what we revive. Pending/Launching/Running are in-flight (the DAG or
# process-compose's own on_failure restart owns them) and Disabled is intentional — left alone,
# so running reconcile right after a cold `devenv up -d` never disrupts a still-starting stack.
needs_heal() {
  case "$1" in
  Completed | Error | Stopped | Terminated | Skipped) return 0 ;;
  *) return 1 ;;
  esac
}

# Heal one process: revive a stopped/gave-up one (start, falling back to restart for a terminal
# state `start` refuses); leave everything else (Disabled, Running, Pending, …) as-is.
heal() {
  local n="$1" s
  s="$(pstatus "$n")"
  if needs_heal "$s"; then
    echo "  ↻ $n — was $s; starting"
    pc process start "$n" >/dev/null 2>&1 || pc process restart "$n" >/dev/null 2>&1 || true
  elif [ "$s" = "Disabled" ]; then
    echo "  • $n — disabled (left as-is)"
  elif [ -z "$s" ]; then
    echo "  • $n — absent (skipped)"
  else
    echo "  • $n — $s (left as-is)"
  fi
}

# Poll until every given process is up (or Disabled), or `timeout` seconds elapse; stragglers
# are appended to `failed`.
wait_tier() {
  local timeout="$1"
  shift
  [ "$#" -eq 0 ] && return 0
  local names=("$@") i n s pending=()
  for ((i = 0; i < timeout; i++)); do
    refresh
    pending=()
    for n in "${names[@]}"; do
      s="$(pstatus "$n")"
      [ "$s" = "Disabled" ] && continue
      is_up "$n" && continue
      pending+=("$n")
      # Revive a process that fell into a terminal state mid-wait — notably Skipped: process-compose
      # skips a manual `pc process start` whose depends_on wasn't healthy yet (e.g. hub-web vs a
      # still-coming-up hub-api), and Skipped never self-recovers. Re-heal once its dependency is up;
      # throttled so a slow starter isn't thrashed. Running-but-not-ready (Vite first-compile) is not
      # terminal, so it's left to finish on its own.
      if needs_heal "$s" && [ "$i" -gt 0 ] && [ $((i % 10)) -eq 0 ]; then heal "$n"; fi
    done
    [ "${#pending[@]}" -eq 0 ] && return 0
    sleep 1
  done
  for n in "${pending[@]}"; do failed+=("$n"); done
  return 1
}

# Read a namespace's process names into the global `names` array (mapfile-free for portability).
collect() {
  names=()
  local line
  while IFS= read -r line; do [ -n "$line" ] && names+=("$line"); done < <(match_ns "$1")
}

# Generic tier: heal every process in a namespace, then wait for the tier to settle.
reconcile_tier() {
  local label="$1" ns="$2" timeout="$3" n
  refresh
  collect "$ns"
  if [ "${#names[@]}" -eq 0 ]; then
    echo "[$label] (none present)"
    return
  fi
  echo "[$label] ${names[*]}"
  for n in "${names[@]}"; do heal "$n"; done
  if wait_tier "$timeout" "${names[@]}"; then echo "  ✓ $label ready"; else echo "  ⚠ $label not all ready after ${timeout}s"; fi
}

echo "── stack-reconcile ──  socket: $PC_SOCK  include-cc: $INCLUDE_CC"

# Sanity: the tiers below select by the process-compose `namespace` field (set per process in devenv).
# If processes exist but none carry a datastore/hub/spoke namespace, every tier would silently heal
# nothing — fail loudly instead (e.g. a process-compose upgrade renamed/dropped the field).
refresh
if [ "$(printf '%s' "$SNAP" | jq -r 'length')" -gt 0 ] && [ -z "$(match_ns datastore)$(match_ns hub)$(match_ns spoke)" ]; then
  echo "✗ stack-reconcile: processes exist but none carry a datastore/hub/spoke namespace — cannot tier by namespace (process-compose 'namespace' field changed?)" >&2
  exit 2
fi

# Tier 0: datastores (process-compose namespace=datastore).
refresh
collect datastore
if [ "${#names[@]}" -eq 0 ]; then
  echo "[datastores] (none present)"
else
  echo "[datastores] ${names[*]}"
  for n in "${names[@]}"; do heal "$n"; done
  if wait_tier 60 "${names[@]}"; then echo "  ✓ datastores ready"; else echo "  ⚠ datastores not all ready after 60s"; fi
fi

# Tier 1+: hub, then spokes, by namespace. Starts are issued for the whole tier at once;
# a manual `pc process start hub-web` whose depends_on (hub-api healthy) isn't satisfied is Skipped
# immediately — it's wait_tier's Skipped-reheal that brings hub-web up once hub-api is ready, NOT
# depends_on (which only orders the initial `up` DAG, not manual starts). The hub window is generous
# (180s) to cover hub-api becoming healthy + hub-web's cold Vite compile in the one combined tier.
# Skipped entirely for the datastores-only scope.
if [ "$SCOPE" != "datastores" ]; then
  # Observability sink (telemetry.enable) BEFORE the hub: hub-api starts exporting OTLP
  # on boot, so the collector should already be listening (exports are fail-soft, but
  # sink-first avoids a burst of dropped spans + retry noise). "(none present)" no-op
  # when absent/Disabled.
  reconcile_tier "observability" observability 60
  reconcile_tier "hub" hub 180
  reconcile_tier "spoke" spoke 90
fi

# The control center itself (namespace=control: lab/lab-web) — only for `task up`. The dashboard
# never sets this: restarting lab/lab-web would kill the cockpit mid-request.
if [ "$INCLUDE_CC" = "1" ]; then
  reconcile_tier "control-center" control 60
fi

echo ""
if [ "${#failed[@]}" -eq 0 ]; then
  echo "✓ stack-reconcile — all supervised processes reconciled and ready."
  exit 0
fi
echo "⚠ stack-reconcile — still not ready after reconcile: ${failed[*]}"
echo "  inspect with: process-compose attach -U   (or the control center logs for that process)"
exit 1
